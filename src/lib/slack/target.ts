import { callClaudeMessages, getAppAiToken } from "@/lib/claude/request";
import { resolveChatExecution } from "@/lib/chat/investigation/model";
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
  | { kind: "ambiguous"; options: RepoCandidate[]; basis: string; aiFailure?: string }
  | { kind: "denied"; repo: string; basis: string };

export type TargetModelResult = { ok: true; text: string } | { ok: false; reason: string; skipped?: boolean };
export type TargetModel = (params: { system: string; prompt: string }) => Promise<TargetModelResult>;

const MAX_OPTIONS = 5;
/** 語の一致で絞った結果が一意とみなせる最低点と、2位に対する倍率 */
const MIN_SCORE = 3;
const DOMINANCE = 2;
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

/**
 * 依頼本文の語（英数字3文字以上・漢字かなの2文字組）を取り出す。リポジトリ名・最近のIssue題名との一致で、
 * AIを使わずに関連候補を絞る手がかりにする。
 */
export function extractTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) terms.add(match[0]);
  for (const match of text.matchAll(/[\u3040-\u30ff\u3400-\u9fff]{2,}/g)) {
    const run = match[0];
    for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

/** 候補ごとの関連度。名称の一致は強く、最近のIssue題名の一致は弱く数える */
export function scoreCandidates(
  text: string,
  candidates: RepoCandidate[],
  hints: Map<string, string[]>,
): { candidate: RepoCandidate; score: number }[] {
  const terms = extractTerms(text);
  return candidates
    .map((candidate) => {
      const name = `${candidate.name} ${candidate.fullName}`.toLowerCase();
      const titles = (hints.get(candidate.fullName) ?? []).join(" ").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 3;
        else if (titles.includes(term)) score += 1;
      }
      return { candidate, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.fullName.localeCompare(b.candidate.fullName));
}

/** AI判別が使えない・曖昧なときの絞り込み。一意なら`resolved`、そうでなければ関連候補だけを返す */
function narrowByTerms(
  text: string,
  candidates: RepoCandidate[],
  hints: Map<string, string[]>,
  basis: string,
  aiFailure?: string,
): TargetDecision {
  const scored = scoreCandidates(text, candidates, hints);
  const [top, second] = scored;
  if (top && top.score >= MIN_SCORE && (!second || top.score >= second.score * DOMINANCE)) {
    return { kind: "resolved", repo: top.candidate.fullName, basis: `${basis}。名称・最近のIssue題名の一致で ${top.candidate.fullName} に絞った（点数 ${top.score}）` };
  }
  return { kind: "ambiguous", options: scored.slice(0, MAX_OPTIONS).map((row) => row.candidate), basis, aiFailure };
}

/**
 * 既定のモデル呼び出し。対象判別は常にClaude APIで行い、OpenAI APIへは送らない。
 * 実行先がCodexのときはAPIを呼ばず（`skipped`）、呼び出し側が名称・Issue題名の一致だけで絞る（#4565）。
 */
export const callTargetModel: TargetModel = async ({ system, prompt }) => {
  if ((await resolveChatExecution()).mode === "codex") {
    return { ok: false, reason: "実行先がCodexのため、対象判別のAI呼び出しは使いません", skipped: true };
  }
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
    return { kind: "ambiguous", options, basis: "投稿に複数のリポジトリが明示されていた" };
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
    // 失敗の原因は消さない。無関係な先頭の候補は並べず、語の一致で絞れた関連候補だけを返す
    return result.skipped
      ? narrowByTerms(text, candidates, hints, `AI判別は使わず語の一致で判別した（${result.reason}）`)
      : narrowByTerms(text, candidates, hints, `AIによる判別ができなかった（${result.reason}）`, result.reason);
  }
  let parsed: { repo?: unknown; confidence?: unknown; candidates?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return narrowByTerms(text, candidates, hints, "AIの判別結果を読み取れなかった", "AIの判別結果を読み取れませんでした");
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
  const related = scoreCandidates(text, candidates, hints).slice(0, MAX_OPTIONS).map((row) => row.candidate);
  const fallback = unique.length > 0 ? unique : picked ? [picked] : related;
  return { kind: "ambiguous", options: fallback, basis: `AIが一意に決められなかった: ${reason || "手がかり不足"}` };
}
