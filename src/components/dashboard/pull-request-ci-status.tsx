import { CiStateBadge } from "@/components/dashboard/pull-request-badges";
import type { PullRequestCiStatus } from "@/lib/github/pull-request-ci";
import type { CiState } from "@/lib/github/release-api";

type PullRequestCiStatusBadgeProps = {
  status: PullRequestCiStatus | null;
};

/**
 * Issue画面が使う`PullRequestCiStatus`を、PR画面と同じ`CiState`へ戻す（#2150）。
 *
 * `none`（権限不足・取得失敗・チェックが1件も無い）は`null`にしてバッジごと出さない
 * （`toPullRequestCiStatus`が`unknown`をここへ寄せている方針をそのまま引き継ぐ）。
 */
function toCiState(status: PullRequestCiStatus): CiState | null {
  if (status === "in_progress") return "pending";
  if (status === "success") return "success";
  if (status === "failure") return "failure";
  return null;
}

/**
 * Issue画面の対応PR・マージ承認待ちカードで、対応PRの最新コミットのCI状態を表示する。
 *
 * **文言も見た目も持たず、PR画面と同じ`CiStateBadge`へ委譲する**（#2150）。以前はここに
 * ラベル表とピルの実装を複製しており、同じPRを見ているのに画面によって「CI成功」「CI通過」と
 * 呼び分けていた（#2145で文言だけ揃えたが、複製自体は残っていた）。持っている型が
 * `PullRequestCiStatus`とPR画面の`CiState`で違うため、この薄い変換だけを残す。
 */
export function PullRequestCiStatusBadge({ status }: PullRequestCiStatusBadgeProps) {
  if (!status) return null;

  return <CiStateBadge ciState={toCiState(status)} />;
}
