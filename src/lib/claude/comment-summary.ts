const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

/** 要約生成に使うモデル。プラン枠消費を抑えるため軽量なモデルを使う。 */
const MODEL = "claude-haiku-4-5";

/** コメント本文が長大な場合に切り詰める上限文字数。 */
const MAX_COMMENT_LENGTH = 4000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(省略)`;
}

/** GitHub Issueの1コメントから要約生成用プロンプトを組み立てる。 */
export function buildCommentSummaryPrompt(body: string): string {
  return `以下はGitHub Issueに投稿された1件のコメントです。内容を「重要な点」「変更点」「懸念点」の3つの見出しに分けて、それぞれ簡潔な箇条書きで日本語で要約してください。該当する内容が無い見出しには「特になし」とだけ記載してください。前置きは付けず、以下の見出し構成のみで出力してください。

## 重要な点
## 変更点
## 懸念点

# コメント本文
${truncate(body, MAX_COMMENT_LENGTH)}`;
}

type AnthropicMessageResponse = {
  content?: { type: string; text?: string }[];
};

/**
 * コメント1件の要約をClaudeに生成させる。
 *
 * `issue-summary.ts`と同様、`CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を直接呼び出す。呼び出しごとにプラン枠を消費するため、
 * 呼び出し元でボタン操作等の明示的なトリガーに限定すること。
 */
export async function generateCommentSummary(token: string, body: string): Promise<string> {
  const prompt = buildCommentSummaryPrompt(body);

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
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Claudeのコメント要約生成に失敗しました (${res.status})`);
  }

  const json = (await res.json()) as AnthropicMessageResponse;
  const text = json.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) {
    throw new Error("Claudeの応答から要約テキストを取得できませんでした");
  }
  return text;
}
