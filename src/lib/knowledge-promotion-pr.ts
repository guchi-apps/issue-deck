import type { PullRequestSummary } from "@/types/pull-request";

/** 共有知識リポジトリ（格上げ判定が反映PRを作る先） */
export const KNOWLEDGE_DOCS_REPOSITORY = "guchi-apps/docs";

/** 格上げ判定が作る反映PRのブランチ名の目印。`promote-knowledge.yml`が使うものと同じ */
export const PROMOTION_BRANCH_PREFIX = "knowledge/promote-";

/**
 * 共通知識の反映PR（`guchi-apps/docs`の`knowledge/promote-*`）か（#3082）。
 *
 * 反映PRは「マージ待ち」ではなく専用メニュー「共通知識」で扱うため、PR一覧の状態別ビュー
 * （`filterPullRequestsByView`）から外す判定に使う。リポジトリ名も見るのは、他のリポジトリが
 * たまたま同じ接頭辞のブランチを切っても外さないため。
 */
export function isPromotionPullRequest(pullRequest: {
  repositoryFullName: string;
  headRef: string;
}): boolean {
  return (
    pullRequest.repositoryFullName === KNOWLEDGE_DOCS_REPOSITORY &&
    pullRequest.headRef.startsWith(PROMOTION_BRANCH_PREFIX)
  );
}

/**
 * 左メニュー「共通知識」に出す、未マージの反映PRの件数（#3082）。
 *
 * `null`は未取得（`loaded`がfalse）。PR一覧は取得に時間がかかるため、取得前に`0`を出すと
 * 「反映PRが無い」と読めてしまう（`computePullRequestNavCounts`と同じ扱い）。
 */
export function countOpenPromotionPullRequests(
  pullRequests: readonly PullRequestSummary[],
  loaded: boolean,
): number | null {
  if (!loaded) return null;
  return pullRequests.filter(
    (pullRequest) =>
      pullRequest.state === "open" && !pullRequest.merged && isPromotionPullRequest(pullRequest),
  ).length;
}

/** 行の吹き出し。件数が無いあいだは従来の説明のまま */
export function describePromotionPullRequests(
  baseDescription: string,
  count: number | null,
): string {
  if (!count) return baseDescription;
  return `マージ待ちの反映PRが${count}件あります（マージまたはcloseされるまで次回の格上げ判定は見送られます）`;
}
