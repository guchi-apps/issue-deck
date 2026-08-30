import { callClaudeMessages } from "@/lib/claude/request";

/** 要約生成に使うモデル。プラン枠消費を抑えるため軽量なモデルを使う。 */

/** コメント本文が長大な場合に切り詰める上限文字数。 */
const MAX_COMMENT_LENGTH = 4000;

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(省略)`;
}

/** GitHub Issueの1コメントから要約生成用プロンプトを組み立てる。 */
export function buildCommentSummaryPrompt(body: string): string {
  return `以下はGitHub Issueに投稿された1件のコメントです。内容を「重要な点」「変更点」「懸念点」「関連Issue」の4つの見出しに分けて、それぞれ簡潔な箇条書きで日本語で要約してください。「関連Issue」の見出しには、コメント中で明示的に言及されているIssue番号（例: #123）や、「必要であれば別途Issueを立てて計画・対応する」といった今後Issue化する可能性がある旨の記述があればその内容を記載してください。該当する内容が無い見出しには「特になし」とだけ記載してください。前置きは付けず、以下の見出し構成のみで出力してください。

## 重要な点
## 変更点
## 懸念点
## 関連Issue

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
 * `/v1/messages`を呼び出す（送信は`request.ts`が担う）。呼び出しごとにプラン枠を消費するため、
 * 呼び出し元でボタン操作等の明示的なトリガーに限定すること。
 */
export async function generateCommentSummary(token: string, body: string): Promise<string> {
  const prompt = buildCommentSummaryPrompt(body);

  const { response: res, json } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "comment_summary",
    token,
    body: {
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    },
  });

  if (!res.ok) {
    throw new Error(`Claudeのコメント要約生成に失敗しました (${res.status})`);
  }

  const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) {
    throw new Error("Claudeの応答から要約テキストを取得できませんでした");
  }
  return text;
}
