import type { CiState } from "@/lib/github/release-api";

export type PullRequestCiStatus = "in_progress" | "success" | "failure" | "none";

/**
 * PR一覧・詳細で使う`CiState`を、Issueの対応PRカードの表記へ写す。
 *
 * 集約そのものは`fetchRefCiState`（`lib/github/release-api.ts`）に一本化している。
 * かつてはここで`/commits/{sha}/check-runs`を独自に集約していたが、無人実行のワークフローの
 * ジョブまで数えてしまい、同じPRでも見る画面によってCI状態が食い違っていた（#1578）。
 *
 * `unknown`（権限不足・取得失敗・チェックが1件も無い）は`none`にする。バッジを出さない側へ倒し、
 * 状態を取れなかったことを「失敗」として見せない。
 */
export function toPullRequestCiStatus(ciState: CiState): PullRequestCiStatus {
  if (ciState === "pending") return "in_progress";
  if (ciState === "success") return "success";
  if (ciState === "failure") return "failure";
  return "none";
}
