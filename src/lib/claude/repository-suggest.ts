const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

/** リポジトリ推定に使うモデル。`issue-suggest.ts`と同じくプラン枠の消費を抑える軽量なもの。 */
const MODEL = "claude-haiku-4-5";

/** 本文が長大な場合に切り詰める上限文字数。 */
const MAX_BODY_LENGTH = 2000;

/** 1リポジトリあたり、判断材料として渡す直近Issueのタイトル数。 */
export const RECENT_TITLE_LIMIT = 5;

export type RepositorySuggestCandidate = {
  fullName: string;
  /**
   * そのリポジトリの直近のIssueタイトル（新しい順）。
   *
   * `Repository`は`description`を持たないため（スキーマを増やさない判断）、
   * **何を扱っているリポジトリなのかはここだけが伝える。** 空でも推定はできるが精度は落ちる。
   */
  recentIssueTitles: string[];
};

export type RepositorySuggestInput = {
  body: string;
  candidates: RepositorySuggestCandidate[];
};

/**
 * 画面へ出す候補の上限（#1710）。
 *
 * **1件だけ決め打ちにしない。** 推定を外したときに、十数件のリストを開いて選び直すのが
 * 唯一の直し方になっていた。順位付きで数件返し、画面ではチップとして並べて1タップで
 * 切り替えられるようにする。4件以上並べてもスマホでは折り返して場所を取るだけなので3件。
 */
export const REPOSITORY_SUGGEST_LIMIT = 3;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(省略)`;
}

/** Issue本文と候補リポジトリから、どのリポジトリの話かを選ばせるプロンプトを組み立てる。 */
export function buildRepositorySuggestPrompt(input: RepositorySuggestInput): string {
  const candidatesText = input.candidates
    .map((candidate) => {
      const titles = candidate.recentIssueTitles
        .slice(0, RECENT_TITLE_LIMIT)
        .map((title) => `    - ${title}`)
        .join("\n");
      return titles
        ? `- ${candidate.fullName}\n  最近のIssue:\n${titles}`
        : `- ${candidate.fullName}`;
    })
    .join("\n");

  return `以下はこれから作成するGitHub Issueの本文です。下記の「候補リポジトリ一覧」の中から、この内容が属するリポジトリとして確からしいものを、確からしい順に最大${REPOSITORY_SUGGEST_LIMIT}件挙げてください。

各リポジトリが何を扱っているかは、リポジトリ名と「最近のIssue」から判断してください。本文に画像のURLが含まれていても、そこからは判断できないので無視してください。

出力は前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。
{"repositories": ["owner/name1", "owner/name2"]}

"repositories"には「候補リポジトリ一覧」に存在するフルネームのみを、確からしい順に含めてください。どれにも当てはまらない場合は空配列を出力してください。

# 本文
${truncate(input.body, MAX_BODY_LENGTH)}

# 候補リポジトリ一覧
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
 * Claudeの応答テキストから、候補に実在するリポジトリのフルネームを確からしい順に取り出す。
 *
 * **候補に無い名前は採らない。** 存在しないリポジトリ名を返されたときに、それらしい名前で
 * 作成へ進んでしまうと、押した本人からは間違いが見えないまま作成が失敗するか、
 * さらに悪い場合は別のリポジトリへ立つ。判定できなければ空配列（＝ユーザーが自分で選ぶ）へ倒す。
 *
 * 単一の`{"repository": "owner/name"}`形式で返ってきた場合も1件として受け取る（#1710以前の
 * 形式で、モデルがそちらの形で返すことがある）。
 */
export function pickSuggestedRepositories(text: string, candidateFullNames: string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const { repositories, repository } = parsed as { repositories?: unknown; repository?: unknown };
  const rawValues = Array.isArray(repositories)
    ? repositories
    : typeof repository === "string"
      ? [repository]
      : [];

  const byLowerName = new Map(candidateFullNames.map((name) => [name.toLowerCase(), name]));
  const picked: string[] = [];
  for (const value of rawValues) {
    if (typeof value !== "string") continue;
    const matched = byLowerName.get(value.trim().toLowerCase());
    if (!matched || picked.includes(matched)) continue;
    picked.push(matched);
    if (picked.length >= REPOSITORY_SUGGEST_LIMIT) break;
  }
  return picked;
}

/**
 * Issue本文から、どのリポジトリのIssueかをClaudeに推定させ、確からしい順の候補を返す。
 *
 * `issue-suggest.ts`と同様、`CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を直接呼び出す。呼び出しごとにプラン枠を消費するため、
 * 呼び出し元をボタン操作等の明示的なトリガーに限定すること。
 *
 * **候補が1件しか無い場合はClaudeを呼ばない**（選ぶ余地が無く、枠を消費するだけのため）。
 */
export async function suggestRepositories(
  token: string,
  input: RepositorySuggestInput,
): Promise<string[]> {
  if (input.candidates.length === 0) return [];
  if (input.candidates.length === 1) return [input.candidates[0].fullName];

  const res = await fetch(`${ANTHROPIC_API}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: "user", content: buildRepositorySuggestPrompt(input) }],
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Claudeのリポジトリ推定に失敗しました (${res.status})`);
  }

  const json = (await res.json()) as AnthropicMessageResponse;
  const text = json.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) return [];

  return pickSuggestedRepositories(
    text,
    input.candidates.map((candidate) => candidate.fullName),
  );
}
