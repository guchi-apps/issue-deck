import { ISSUE_SEARCH_CANDIDATE_LIMIT } from "@/lib/claude/limits";
import { callClaudeMessages } from "@/lib/claude/request";

/** あいまい検索に使うモデル。プラン枠の消費を抑える軽量なもの。 */


/** 1回の判定で残すIssueの上限。これを超えると絞り込みとして役に立たないため。 */
export const ISSUE_SEARCH_RESULT_LIMIT = 50;

/** 検索語（トークンを除いた自由語）の上限文字数。 */
const MAX_QUERY_LENGTH = 200;

/**
 * 判定材料として渡すIssue1件。
 *
 * **本文は含めない。** タイトルとラベルだけで意味の近さは十分に判断でき、本文まで載せると
 * 候補300件で入力が数十万文字になる。`key`は`owner/repo#123`形式で、応答を突き合わせる
 * ときの識別子になる（Issueのidは長いノードIDで、プロンプトに載せるだけ枠を消費する）。
 */
export type IssueSearchCandidate = {
  key: string;
  title: string;
  labels: string[];
};

export type IssueSearchInput = {
  query: string;
  candidates: IssueSearchCandidate[];
};

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(省略)`;
}

/** 検索語と候補Issueから、意味の近いIssueを選ばせるプロンプトを組み立てる。 */
export function buildIssueSearchPrompt(input: IssueSearchInput): string {
  const candidatesText = input.candidates
    .map((candidate) => {
      const labels = candidate.labels.length > 0 ? ` [${candidate.labels.join(", ")}]` : "";
      return `- ${candidate.key} ${candidate.title}${labels}`;
    })
    .join("\n");

  return `以下は、GitHub Issueの一覧を検索している人が入力した検索語です。下記の「候補Issue一覧」の中から、この検索語が探していると考えられるIssueを、確からしい順に最大${ISSUE_SEARCH_RESULT_LIMIT}件挙げてください。

文字列がそのまま含まれているかではなく、**意味が近いか**で判断してください（例: 「検索が遅い」に対して「一覧の絞り込みが重い」は該当する）。表記ゆれ・言い換え・略語も同じものとして扱ってください。関係が薄いものは無理に含めず、当てはまるものが無ければ空配列を返してください。

出力は前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。
{"issues": ["owner/name#12", "owner/name#34"]}

"issues"には「候補Issue一覧」に存在するキー（行頭の\`owner/name#番号\`）のみを、確からしい順に含めてください。

# 検索語
${truncate(input.query, MAX_QUERY_LENGTH)}

# 候補Issue一覧
${candidatesText}`;
}

type AnthropicMessageResponse = {
  content?: { type: string; text?: string }[];
};

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Claudeの応答テキストから、候補に実在するIssueのキーを確からしい順に取り出す。
 *
 * **候補に無いキーは採らない。** 存在しないIssueを
 * 返されたときにそのまま絞り込みへ渡すと、画面には「0件」とだけ出て、なぜ消えたのかが
 * 押した本人から見えない。JSONとして読めない応答も同様に空配列（＝該当なし）へ倒す。
 */
export function pickMatchedIssueKeys(text: string, candidateKeys: string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const { issues } = parsed as { issues?: unknown };
  if (!Array.isArray(issues)) return [];

  const byLowerKey = new Map(candidateKeys.map((key) => [key.toLowerCase(), key]));
  const picked: string[] = [];
  for (const value of issues) {
    if (typeof value !== "string") continue;
    const matched = byLowerKey.get(value.trim().toLowerCase());
    if (!matched || picked.includes(matched)) continue;
    picked.push(matched);
    if (picked.length >= ISSUE_SEARCH_RESULT_LIMIT) break;
  }
  return picked;
}

/**
 * 検索語に意味が近いIssueをClaudeに選ばせ、そのキーを確からしい順に返す。
 *
 * `CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を呼び出す（送信は`request.ts`が担う）。**呼び出しごとにプラン枠を消費するため、入力のたびではなく
 * ボタンを押したときだけ呼ぶ**（画面側の`use-issue-ai-search.ts`もEnterには割り当てていない）。
 *
 * 候補が0件ならClaudeを呼ばない（判定する対象が無く、枠を消費するだけのため）。
 */
export async function searchIssues(token: string, input: IssueSearchInput): Promise<string[]> {
  const candidates = input.candidates.slice(0, ISSUE_SEARCH_CANDIDATE_LIMIT);
  if (candidates.length === 0) return [];

  const { response: res, json } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "issue_search",
    token,
    body: {
      max_tokens: 1024,
      messages: [{ role: "user", content: buildIssueSearchPrompt({ ...input, candidates }) }],
    },
  });

  if (!res.ok) {
    throw new Error(`Claudeのあいまい検索に失敗しました (${res.status})`);
  }

  const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) return [];

  return pickMatchedIssueKeys(
    text,
    candidates.map((candidate) => candidate.key),
  );
}
