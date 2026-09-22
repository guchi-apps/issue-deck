/**
 * `11.local`付きIssueへの`@claude`コメントを、生きているローカルセッションへ伝えるための
 * 固定文言（#3331）。
 *
 * `reusable-issue-dispatch.yml`のissue_commentトリガーは、`11.local`が付いたIssueへの
 * `@claude`コメントを「ラベルを外して改めて呼びかけてください」という案内で終えるだけで、
 * 実際に動いているローカルセッションには何も伝わっていなかった。`POST /api/dispatch/comment-relay`
 * が、セッションが生きていることを確かめたうえで`INSTRUCTION`ジョブにこの1行を積む。
 *
 * `DispatchJob.instruction`は改行なし1行しか受け付けないため、コメント本文そのものではなく
 * 「読みに行け」という固定文を送る（既存の`PR_FIX_SESSION_INSTRUCTION`・#2919と同じ形）。
 */
export const COMMENT_RELAY_SESSION_INSTRUCTION =
  "Issueに新しいコメントが届きました。読んで対応してください。";
