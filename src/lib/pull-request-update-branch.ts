import { classifyPullRequest } from "@/lib/pull-request-list";

/**
 * 通常PRのheadブランチへ、最新のbase（マージ先）を取り込む操作の判定と文言（#4626）。
 *
 * **サーバーが、操作の直前にGitHubから取り直した現在のPRを渡して判定する。** 画面が持つ
 * `headSha`は古いことがあり、期待したSHAと違うheadへは取り込まない（`expected_head_sha`も
 * GitHubへ渡して二重に守る）。headをbaseへマージする操作ではない。
 */
export type UpdateBranchErrorCode =
  | "not_found"
  | "pull_request_not_open"
  | "head_changed"
  | "release_pull_request"
  | "fork_not_updatable"
  | "conflict"
  | "already_up_to_date"
  | "permission_denied"
  | "github_api_error";

export type UpdateBranchDecision =
  | { action: "update" }
  | {
      action: "reject";
      code: Extract<
        UpdateBranchErrorCode,
        "pull_request_not_open" | "head_changed" | "release_pull_request" | "fork_not_updatable" | "conflict"
      >;
    };

export function decideUpdateBranch(
  current: {
    state: string;
    merged: boolean;
    baseRef: string;
    headRef: string;
    headSha: string;
    headRepoFullName: string | null;
    baseRepoFullName: string;
    mergeableState: string;
  },
  requestedHeadSha: string,
): UpdateBranchDecision {
  if (current.merged || current.state !== "open") return { action: "reject", code: "pull_request_not_open" };
  if (current.headSha !== requestedHeadSha) return { action: "reject", code: "head_changed" };
  // 凍結したリリース候補へ無関係なdevelop全体を取り込む導線にはしない（候補の作り直しは別機能）
  const kind = classifyPullRequest({ baseRef: current.baseRef, headRef: current.headRef });
  if (kind === "release" || kind === "version-bump") return { action: "reject", code: "release_pull_request" };
  if (current.headRepoFullName !== current.baseRepoFullName) return { action: "reject", code: "fork_not_updatable" };
  if (current.mergeableState === "dirty") return { action: "reject", code: "conflict" };
  return { action: "update" };
}

/** 画面に出す日本語の理由と、次にやること */
export function updateBranchErrorMessage(code: string | undefined, baseRef?: string): string {
  const base = baseRef ?? "マージ先";
  switch (code) {
    case "pull_request_not_open":
      return "このPRはすでにクローズまたはマージされています。「更新」を押して最新の状態を確認してください。";
    case "head_changed":
      return "PRのコミットが更新されています。「更新」を押して最新の状態を確認してから、もう一度押してください。";
    case "release_pull_request":
      return "リリースPR・バージョンバンプPRには使えません。リリース候補の修正は、リリースの画面から作り直してください。";
    case "fork_not_updatable":
      return "フォークからのPRのため、IssueDeckからは更新できません。フォーク側でブランチを更新してください。";
    case "conflict":
      return `${base}と競合しているため取り込めません。競合の自動解消（PRを自動修正）を使うか、競合を手で解消してください。`;
    case "already_up_to_date":
      return `すでに最新の${base}を取り込み済みです。CIが止まっている場合は「CIを再実行」を使ってください。`;
    case "permission_denied":
      return "GitHub Appにリポジトリの書き込み権限（Contents）がないか、ブランチ保護で更新できません。権限を確認するか、GitHubで開いて更新してください。";
    case "not_found":
      return "対象のPRが見つかりません。「更新」を押して一覧を取り直してください。";
    default:
      return `最新の${base}の取り込みに失敗しました。少し待ってからもう一度押してください。`;
  }
}
