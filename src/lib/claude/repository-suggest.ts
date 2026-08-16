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

  return `以下はこれから作成するGitHub Issueの本文です。下記の「候補リポジトリ一覧」の中から、この内容が属するリポジトリを1つ選んでください。

各リポジトリが何を扱っているかは、リポジトリ名と「最近のIssue」から判断してください。

出力は前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。
{"repository": "owner/name"}

"repository"には「候補リポジトリ一覧」に存在するフルネームのみを指定してください。どれにも当てはまらない場合は{"repository": null}を出力してください。

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
 * Claudeの応答テキストから、候補に実在するリポジトリのフルネームを取り出す。
 *
 * **候補に無い名前は採らない。** 存在しないリポジトリ名を返されたときに、それらしい名前で
 * 作成へ進んでしまうと、押した本人からは間違いが見えないまま作成が失敗するか、
 * さらに悪い場合は別のリポジトリへ立つ。判定できなければ`null`（＝ユーザーが自分で選ぶ）へ倒す。
 */
export function pickSuggestedRepository(text: string, candidateFullNames: string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const value = (parsed as { repository?: unknown }).repository;
  if (typeof value !== "string") return null;

  const byLowerName = new Map(candidateFullNames.map((name) => [name.toLowerCase(), name]));
  return byLowerName.get(value.trim().toLowerCase()) ?? null;
}

/**
 * Issue本文から、どのリポジトリのIssueかをClaudeに推定させる。
 *
 * `issue-suggest.ts`と同様、`CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を直接呼び出す。呼び出しごとにプラン枠を消費するため、
 * 呼び出し元をボタン操作等の明示的なトリガーに限定すること。
 *
 * **候補が1件しか無い場合はClaudeを呼ばない**（選ぶ余地が無く、枠を消費するだけのため）。
 */
export async function suggestRepository(
  token: string,
  input: RepositorySuggestInput,
): Promise<string | null> {
  if (input.candidates.length === 0) return null;
  if (input.candidates.length === 1) return input.candidates[0].fullName;

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
  if (!text) return null;

  return pickSuggestedRepository(
    text,
    input.candidates.map((candidate) => candidate.fullName),
  );
}
