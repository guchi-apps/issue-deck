import { callClaudeMessages } from "@/lib/claude/request";

/** 要約生成に使うモデル。プラン枠消費を抑えるため軽量なモデルを使う。 */

/** 本文が長大な場合に切り詰める上限文字数。 */
const MAX_BODY_LENGTH = 4000;
/** 各コメントを切り詰める上限文字数。 */
const MAX_COMMENT_LENGTH = 1000;
/** プロンプトに含めるコメントの最大件数。超過分は古い方から除外する（直近の議論の方が要約に重要なため）。 */
const MAX_COMMENTS = 30;

export type IssueSummaryCommentInput = {
  author: string;
  body: string;
};

export type IssueSummaryInput = {
  title: string;
  body: string;
  comments: IssueSummaryCommentInput[];
};

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(省略)`;
}

/** Issueのタイトル・本文・コメントから要約生成用プロンプトを組み立てる。 */
export function buildIssueSummaryPrompt(input: IssueSummaryInput): string {
  const { title, body, comments } = input;

  const omittedCount = Math.max(0, comments.length - MAX_COMMENTS);
  const trimmedComments = omittedCount > 0 ? comments.slice(omittedCount) : comments;

  const commentsText =
    trimmedComments.length > 0
      ? trimmedComments
          .map(
            (comment, index) =>
              `### コメント${index + 1} (${comment.author})\n${truncate(comment.body, MAX_COMMENT_LENGTH)}`,
          )
          .join("\n\n")
      : "(コメントなし)";
  const omittedNote = omittedCount > 0 ? `\n\n(古い${omittedCount}件のコメントは省略されています)` : "";

  return `以下はGitHub Issueのタイトル・本文・コメント一覧です。このIssueが「どんな問題に対して」「どのように対応したか（対応中の場合は現状どこまで進んでいるか）」を、日本語で3〜5文程度に要約してください。前置きや見出しは付けず、要約の本文のみを出力してください。

# タイトル
${title}

# 本文
${truncate(body, MAX_BODY_LENGTH)}

# コメント${omittedNote}
${commentsText}`;
}

type AnthropicMessageResponse = {
  content?: { type: string; text?: string }[];
};

/**
 * Issueの要約をClaudeに生成させる。
 *
 * `usage.ts`と同様、`CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を呼び出す（送信は`request.ts`が担う）。呼び出しごとにプラン枠を消費するため、
 * 呼び出し元でボタン操作等の明示的なトリガーに限定すること。
 */
export async function generateIssueSummary(token: string, input: IssueSummaryInput): Promise<string> {
  const prompt = buildIssueSummaryPrompt(input);

  const { response: res, json } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "issue_summary",
    token,
    body: {
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    },
  });

  if (!res.ok) {
    throw new Error(`AIによる要約生成に失敗しました (${res.status})`);
  }

  const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) {
    throw new Error("AIの応答から要約テキストを取得できませんでした");
  }
  return text;
}
