/**
 * ドラフトPRを「レビュー可能」へ切り替える操作の判定と文言（#4453）。
 *
 * **サーバー側が、操作の直前にGitHubから取り直した現在のPRを渡して判定する。** 画面が持つ
 * `draft`・`headSha`は古いことがあるため、画面の値だけでmutationを撃たない。
 */
export type ReadyForReviewErrorCode =
  | "not_found"
  | "pull_request_not_open"
  | "head_changed"
  | "permission_denied"
  | "github_api_error";

export type ReadyForReviewDecision =
  | { action: "mark" }
  /** 既にレビュー可能。同じmutationを重ねず、最新状態の再取得だけをさせる */
  | { action: "already_ready" }
  | { action: "reject"; code: "pull_request_not_open" | "head_changed" };

export function decideReadyForReview(
  current: { state: string; merged: boolean; draft: boolean; headSha: string },
  requestedHeadSha: string,
): ReadyForReviewDecision {
  if (current.merged || current.state !== "open") return { action: "reject", code: "pull_request_not_open" };
  if (current.headSha !== requestedHeadSha) return { action: "reject", code: "head_changed" };
  if (!current.draft) return { action: "already_ready" };
  return { action: "mark" };
}

/** 画面に出す日本語の理由と再試行方法。成功扱いにせず、何をすればよいかまで書く */
export function readyForReviewErrorMessage(code: string | undefined): string {
  switch (code) {
    case "pull_request_not_open":
      return "このPRはすでにクローズまたはマージされています。「更新」を押して最新の状態を確認してください。";
    case "head_changed":
      return "PRのコミットが更新されています。「更新」を押して最新の状態を確認してから、もう一度押してください。";
    case "permission_denied":
      return "GitHub AppにPull requestsの書き込み権限がありません。権限を付与するか、GitHubで開いて切り替えてください。";
    case "not_found":
      return "対象のPRが見つかりません。「更新」を押して一覧を取り直してください。";
    default:
      return "GitHubへの切り替えに失敗しました。少し待ってからもう一度押すか、GitHubで開いて切り替えてください。";
  }
}
