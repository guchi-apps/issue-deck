import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";

/**
 * リリース・デプロイが動いているリポジトリの件数（#2167）。
 *
 * 数えるのは**リポジトリ（プロジェクト）の数**であって、PRの本数でもIssueの件数でもない。
 * メニューの「ブランチ」行は「いくつのプロジェクトが動いているか」を出す場所で、
 * 開いた先のブランチ画面もリポジトリ単位で並ぶため、そこと数え方を揃える。
 *
 * **手作業（`71.manual-step`）は数えない。** あれは「ユーザーの作業待ち」の行が持つ別の項目で、
 * 両方の行に同じものが出ると、どちらを押せば片付くのか分からなくなる。
 */
export type ReleaseActivityCounts = {
  /** リリース・デプロイの作業が動いているリポジトリ数（`idle`以外のすべて） */
  total: number;
  /**
   * そのうち**人が操作するまで進まない**リポジトリ数。
   * バージョンバンプPR・リリースPRのマージ待ち（`action_required`）と、
   * リリース・本番デプロイの失敗（`error`）。
   */
  actionRequired: number;
};

/**
 * リリース状況のサマリ（`GET /api/repositories/release-pending-merges`）から、
 * リリース・デプロイが動いているリポジトリ数と、そのうち操作待ちの数を数える。
 *
 * **APIは`idle`のリポジトリを返さない**（`api/repositories/release-pending-merges/route.ts`）ため、
 * 返ってきた件数がそのまま「動いているプロジェクト数」になる。
 *
 * **未取得（`null`）と0件を区別して返す。** 未取得のうちは`null`を返し、呼ぶ側は数字を出さない。
 * 0を出すと「動いているものが無い」と読めてしまうため（`countReleaseMergePending`と同じ作法）。
 */
export function countReleaseActivity(
  releaseStatuses: RepositoryReleaseStatus[] | null,
): ReleaseActivityCounts | null {
  if (releaseStatuses === null) return null;

  return {
    total: releaseStatuses.length,
    actionRequired: releaseStatuses.filter(
      (releaseStatus) =>
        releaseStatus.status === "action_required" || releaseStatus.status === "error",
    ).length,
  };
}

/**
 * メニューの「ブランチ」行に添える文言（`title`）。
 *
 * **数字と丸で意味が違う**ため、行のラベル（「ブランチ」）からは何を数えているのか読めない。
 * 数字は動いているプロジェクト数、オレンジの丸は「そのうち人が操作するまで進まないものがある」
 * という合図なので、内訳をここで補う（「質問」の行の`formatQuestionNavTitle`と同じ考え方）。
 */
export function describeReleaseActivity(counts: ReleaseActivityCounts | null): string {
  const base = "Issue・ブランチ・Pull Requestの関係とマージ先までの流れ";
  if (counts === null || counts.total === 0) {
    return `${base}（リリース・デプロイ中のプロジェクトはありません）`;
  }

  const detail =
    counts.actionRequired > 0
      ? `リリース・デプロイ中${counts.total}件・うち操作待ち${counts.actionRequired}件`
      : `リリース・デプロイ中${counts.total}件`;
  return `${base}（${detail}）`;
}
