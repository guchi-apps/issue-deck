import { callClaudeMessages } from "@/lib/claude/request";

/** 整形生成に使うモデル。プラン枠消費を抑えるため軽量なモデルを使う。 */

/** 本文が長大な場合に切り詰める上限文字数。 */
const MAX_BODY_LENGTH = 4000;

/** 整形後の本文が元の本文と同程度の長さになりうるため、要約系（1024）より大きめに確保する。 */
const MAX_TOKENS = 4096;

export type IssueBodyCleanupResult = {
  text: string;
};

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(省略)`;
}

/** 音声入力で書き起こされた本文から、整形用プロンプトを組み立てる。 */
export function buildIssueBodyCleanupPrompt(body: string): string {
  return `以下は音声入力によって書き起こされたGitHub Issueの本文です。フィラー（「あの」「えーと」等）・言い淀み・句読点の欠落・話し言葉といった音声入力特有のノイズを取り除き、読みやすい書き言葉に整形してください。

情報の追加・削除・意味の変更は行わず、話し言葉から書き言葉への変換と、句読点・改行・箇条書き等のMarkdown整形のみを行ってください。

出力は前置きや説明・コードフェンスを一切付けず、整形後の本文のみを出力してください。

# 本文
${truncate(body, MAX_BODY_LENGTH)}`;
}

type AnthropicMessageResponse = {
  content?: { type: string; text?: string }[];
};

/**
 * 音声入力で書き起こされたIssue本文をClaudeに整形させる。
 *
 * `issue-suggest.ts`と同様、`CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を呼び出す（送信は`request.ts`が担う）。呼び出しごとにプラン枠を消費するため、
 * 呼び出し元でボタン操作等の明示的なトリガーに限定すること。
 */
export async function generateIssueBodyCleanup(
  token: string,
  body: string,
): Promise<IssueBodyCleanupResult> {
  const prompt = buildIssueBodyCleanupPrompt(body);

  const { response: res, json } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "issue_body_cleanup",
    token,
    body: {
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    },
  });

  if (!res.ok) {
    throw new Error(`Claudeの本文整形に失敗しました (${res.status})`);
  }

  const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) {
    throw new Error("Claudeの応答から整形結果を取得できませんでした");
  }

  return { text };
}
