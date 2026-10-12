import { callClaudeMessages, getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";
import { guessRepo, type RepoCandidate } from "@/lib/slack/candidates";

/**
 * Slack起案の対象リポジトリの判別（#4527）。許可済み候補（`listRepoCandidates`）の中だけから選ぶ。
 *
 * 1. 投稿にowner/repoが明示されていれば、それを最優先する（候補に無ければ`denied`＝権限外・未接続）
 * 2. リポジトリ名が一意に書かれていれば、それを使う（`guessRepo`）
 * 3. それ以外は、AIが投稿本文・スレッドの補足・候補の名称と最近のIssue題名から判断する
 *
 * AIが一意に決められない・使えないときは`ambiguous`を返し、呼び出し側が利用者へ対象を聞く。
 * **AIの出力は候補に含まれるものだけを受け付ける**（候補外のリポジトリは作成先にならない）。
 */
export type TargetDecision =
  | { kind: "resolved"; repo: string; basis: string }
  | { kind: "ambiguous"; options: RepoCandidate[]; basis: string }
  | { kind: "denied"; repo: string; basis: string };

export type TargetModelResult = { ok: true; text: string } | { ok: false; reason: string };
export type TargetModel = (params: { system: string; prompt: string }) => Promise<TargetModelResult>;

const MAX_OPTIONS = 5;
/** AIが使えず絞れないときに質問へ並べる候補の上限 */
const MAX_LISTED = 15;
const HINT_TITLES_PER_REPO = 6;

const TARGET_SCHEMA = {
  type: "object",
  properties: {
    repo: { type: "string", description: "候補のowner/repo。一意に決められなければ空文字" },
    confidence: { type: "string", enum: ["high", "low"] },
    candidates: { type: "array", items: { type: "string" }, description: "決められないとき、可能性のある候補のowner/repo（多くて5件）" },
    reason: { type: "string", description: "判定根拠を日本語で1〜2文" },
  },
  required: ["repo", "confidence", "candidates", "reason"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  "あなたはSlackに投稿された改善・不具合の依頼が、どのリポジトリ（アプリ）のものかを判別する。",
  "候補（owner/repo）の中からだけ選ぶ。候補に無いものは絶対に答えない。",
  "投稿本文・同じスレッドの補足・アプリの日本語表示名や別名・機能の内容・候補ごとの最近のIssue題名を根拠にする。",
  "一意に決められるときだけ confidence=high で repo を答える。複数に当てはまる・手がかりが乏しいときは repo を空にし、confidence=low で可能性のある候補を candidates に挙げる。",
  "推測で決めない。投稿にない仕様を足さない。",
].join("\n");

export function extractExplicitRepos(text: string, candidates: RepoCandidate[]): { found: string[]; denied: string[] } {
  const owners = new Set(candidates.map((c) => c.fullName.split("/")[0].toLowerCase()));
  const known = new Map(candidates.map((c) => [c.fullName.toLowerCase(), c.fullName]));
  const found = new Set<string>();
  const denied = new Set<string>();
  for (const match of text.matchAll(/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)/g)) {
    const full = `${match[1]}/${match[2]}`.replace(/[.]+$/, "");
    const hit = known.get(full.toLowerCase());
    if (hit) found.add(hit);
    else if (owners.has(match[1].toLowerCase())) denied.add(full);
  }
  return { found: [...found], denied: [...denied] };
}

async function loadHints(candidates: RepoCandidate[]): Promise<Map<string, string[]>> {
  const hints = new Map<string, string[]>();
  try {
    const rows = await db.issue.findMany({
      where: { repository: { fullName: { in: candidates.map((c) => c.fullName) } } },
      orderBy: { githubUpdatedAt: "desc" },
      take: candidates.length * HINT_TITLES_PER_REPO * 2,
      select: { title: true, repository: { select: { fullName: true } } },
    });
    for (const row of rows) {
      const list = hints.get(row.repository.fullName) ?? [];
      if (list.length < HINT_TITLES_PER_REPO) list.push(row.title.slice(0, 60));
      hints.set(row.repository.fullName, list);
    }
  } catch {
    // 手がかりは補助。取れなくても名称だけで判別する
  }
  return hints;
}

/** 既定のモデル呼び出し。実行先がGPT系でもOpenAI APIへは送らずClaude系へ固定される（`callClaudeMessages`） */
export const callTargetModel: TargetModel = async ({ system, prompt }) => {
  const token = await getAppAiToken("chat_investigation");
  if (!token) return { ok: false, reason: "AIの認証情報が設定されていません" };
  try {
    const { response, json, error } = await callClaudeMessages({
      feature: "chat_investigation",
      token,
      timeoutMs: 60_000,
      body: {
        max_tokens: 600,
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: { type: "json_schema", schema: TARGET_SCHEMA } },
      },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}${error?.code ? ` ${error.code}` : ""}` };
    const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
    return text ? { ok: true, text } : { ok: false, reason: "応答が空でした" };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error && cause.name === "TimeoutError" ? "時間切れ" : "通信に失敗しました" };
  }
};

export async function resolveTarget(
  text: string,
  candidates: RepoCandidate[],
  deps: { callModel?: TargetModel } = {},
): Promise<TargetDecision> {
  const explicit = extractExplicitRepos(text, candidates);
  if (explicit.found.length === 1 && explicit.denied.length === 0) {
    return { kind: "resolved", repo: explicit.found[0], basis: `投稿に ${explicit.found[0]} が明示されていた` };
  }
  if (explicit.found.length === 0 && explicit.denied.length > 0) {
    return { kind: "denied", repo: explicit.denied[0], basis: `投稿に明示された ${explicit.denied[0]} は接続済みで権限のある候補にない` };
  }
  if (explicit.found.length + explicit.denied.length > 1) {
    const options = candidates.filter((c) => explicit.found.includes(c.fullName)).slice(0, MAX_OPTIONS);
    return { kind: "ambiguous", options: options.length ? options : candidates.slice(0, MAX_LISTED), basis: "投稿に複数のリポジトリが明示されていた" };
  }
  const guessed = guessRepo(text, candidates);
  if (guessed) return { kind: "resolved", repo: guessed, basis: `投稿中のリポジトリ名の一致（${guessed}）` };

  const hints = await loadHints(candidates);
  const prompt = [
    "## 候補（owner/repo）",
    ...candidates.map((c) => {
      const titles = hints.get(c.fullName);
      return `- ${c.fullName}${titles?.length ? `（最近のIssue: ${titles.join(" / ")}）` : ""}`;
    }),
    "",
    "## 依頼（Slackの投稿とスレッドの補足）",
    text.slice(0, 4000),
  ].join("\n");
  const result = await (deps.callModel ?? callTargetModel)({ system: SYSTEM_PROMPT, prompt });
  if (!result.ok) {
    return { kind: "ambiguous", options: candidates.slice(0, MAX_LISTED), basis: `AIによる判別ができなかった（${result.reason}）` };
  }
  let parsed: { repo?: unknown; confidence?: unknown; candidates?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return { kind: "ambiguous", options: candidates.slice(0, MAX_LISTED), basis: "AIの判別結果を読み取れなかった" };
  }
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "";
  const byName = new Map(candidates.map((c) => [c.fullName.toLowerCase(), c]));
  const picked = typeof parsed.repo === "string" ? byName.get(parsed.repo.trim().toLowerCase()) : undefined;
  if (picked && parsed.confidence === "high") {
    return { kind: "resolved", repo: picked.fullName, basis: `AIが候補から判別: ${reason || picked.fullName}` };
  }
  const options = (Array.isArray(parsed.candidates) ? parsed.candidates : [])
    .map((value) => (typeof value === "string" ? byName.get(value.trim().toLowerCase()) : undefined))
    .filter((c): c is RepoCandidate => Boolean(c));
  const unique = [...new Map(options.map((c) => [c.fullName, c])).values()].slice(0, MAX_OPTIONS);
  const fallback = unique.length > 0 ? unique : picked ? [picked] : candidates.slice(0, MAX_LISTED);
  return { kind: "ambiguous", options: fallback, basis: `AIが一意に決められなかった: ${reason || "手がかり不足"}` };
}
