import type { GithubApiOpenPullRequest } from "@/lib/github/pull-requests-api";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * ブランチ画面の「過去のリリース」で、さらに古い版をGitHubから取り足す（#4844）。
 *
 * 画面を開いたときの母集団は「更新が新しい順の30件」（`fetchClosedPullRequests`）だけで、
 * 遡れるのは直近2〜3版ぶん。それより古い版は、利用者が「さらに表示」を押したときだけ
 * develop宛・main宛のクローズ済みPRをページ単位で取り、母集団へ足して束を作り直す。
 */

/** 1回の押下で取りに行くmain宛のページの上限。develop宛は常に1ページ */
export const HISTORY_MAX_MAIN_PAGES_PER_LOAD = 3;

/** 次に取るページ番号。`null`はその向きを取り切ったこと */
export type BranchFlowHistoryCursor = {
  developPage: number | null;
  mainPage: number | null;
};

export const INITIAL_HISTORY_CURSOR: BranchFlowHistoryCursor = { developPage: 1, mainPage: 1 };

/** `GET /api/branch-flow/history`の応答 */
export type BranchFlowHistoryResponse = {
  pullRequests: PullRequestSummary[];
  cursor: BranchFlowHistoryCursor;
  /** これまでに取ったmain宛PRのうち最も古い作成時刻。次の押下でmain宛を取り足すかの判定に使う */
  mainOldestCreatedAt: string | null;
};

/** まだ取りに行ける続きがあるか。どちらかの向きに続きがあれば押せる */
export function hasMoreHistory(cursor: BranchFlowHistoryCursor): boolean {
  return cursor.developPage !== null || cursor.mainPage !== null;
}

/**
 * 取ったページが上限件数と同数なら続きがあるとみなす。総数を数える手段は無く、
 * ちょうど上限で終わっていた場合は次の押下で0件が返って取り切りになる。
 */
export function nextHistoryPage(page: number, fetchedCount: number, perPage: number): number | null {
  return fetchedCount >= perPage ? page + 1 : null;
}

/**
 * main宛のページをもう1枚取るか。
 *
 * **main宛はdevelop宛と同じ深さまで取る。** 版の割り当て（`resolveReleaseState`）は
 * 「そのレーンより後に凍結された最初の版」を運び手にするため、取った版より古いレーンがあると
 * 取得済みの最古の版へ誤って束ねられる。main宛（リリースPR）はdevelop宛より疎なので、
 * 取得済みの最古がdevelop宛の最古より新しい間だけ取り足せば、多くは1ページで済む。
 *
 * 今回develop宛を1件も取らなかった（developを持たないリポジトリ・取り切った後）ときは、
 * main宛が唯一の続きなので1押下につき1ページだけ進める。
 */
export function shouldFetchMoreMain({
  developOldestCreatedAt,
  mainOldestCreatedAt,
  fetchedMainPages,
}: {
  developOldestCreatedAt: string | null;
  mainOldestCreatedAt: string | null;
  fetchedMainPages: number;
}): boolean {
  if (fetchedMainPages >= HISTORY_MAX_MAIN_PAGES_PER_LOAD) return false;
  if (developOldestCreatedAt === null) return fetchedMainPages === 0;
  if (mainOldestCreatedAt === null) return true;
  return new Date(mainOldestCreatedAt).getTime() > new Date(developOldestCreatedAt).getTime();
}

function oldestCreatedAt(pullRequests: GithubApiOpenPullRequest[], current: string | null): string | null {
  let oldest = current;
  for (const pullRequest of pullRequests) {
    if (oldest === null || new Date(pullRequest.created_at).getTime() < new Date(oldest).getTime()) {
      oldest = pullRequest.created_at;
    }
  }
  return oldest;
}

/**
 * 1回の押下ぶんを取る。GitHubへの問い合わせは`fetchPage`に任せる（テストから差し替える）。
 * develop宛を1ページ取り、`shouldFetchMoreMain`が許す間main宛を取り足す。
 */
export async function fetchBranchFlowHistoryPage({
  cursor,
  mainOldestCreatedAt,
  perPage,
  fetchPage,
}: {
  cursor: BranchFlowHistoryCursor;
  mainOldestCreatedAt: string | null;
  perPage: number;
  fetchPage: (base: "develop" | "main", page: number) => Promise<GithubApiOpenPullRequest[]>;
}): Promise<{
  pullRequests: GithubApiOpenPullRequest[];
  cursor: BranchFlowHistoryCursor;
  mainOldestCreatedAt: string | null;
}> {
  const pullRequests: GithubApiOpenPullRequest[] = [];
  let { developPage, mainPage } = cursor;

  let developOldest: string | null = null;
  if (developPage !== null) {
    const fetched = await fetchPage("develop", developPage);
    pullRequests.push(...fetched);
    developOldest = oldestCreatedAt(fetched, null);
    developPage = nextHistoryPage(developPage, fetched.length, perPage);
  }

  let mainOldest = mainOldestCreatedAt;
  let fetchedMainPages = 0;
  while (
    mainPage !== null &&
    shouldFetchMoreMain({
      developOldestCreatedAt: developOldest,
      mainOldestCreatedAt: mainOldest,
      fetchedMainPages,
    })
  ) {
    const fetched = await fetchPage("main", mainPage);
    pullRequests.push(...fetched);
    mainOldest = oldestCreatedAt(fetched, mainOldest);
    mainPage = nextHistoryPage(mainPage, fetched.length, perPage);
    fetchedMainPages += 1;
  }

  return { pullRequests, cursor: { developPage, mainPage }, mainOldestCreatedAt: mainOldest };
}

function pullRequestKey(pullRequest: PullRequestSummary): string {
  return `${pullRequest.repositoryFullName}#${pullRequest.number}`;
}

/**
 * 画面の母集団へ、追加取得したPRを重複なしで足す（#4844）。
 *
 * 母集団（更新順）と追加取得（作成順）は並びが違い、範囲も重なるので、リポジトリと番号で
 * 重ねる。**同じPRは母集団の側を残す**——そちらは最新の状態を10秒ごとに取り直しており、
 * マージ直後の楽観的更新（`applyOptimisticMerges`）も載っているため。
 * 追加分が無ければ母集団をそのまま返す（参照が変わらないので作り直しを起こさない）。
 */
export function mergeHistoryPullRequests(
  pullRequests: PullRequestSummary[],
  history: readonly PullRequestSummary[],
): PullRequestSummary[] {
  if (history.length === 0) return pullRequests;
  const seen = new Set(pullRequests.map(pullRequestKey));
  const merged = [...pullRequests];
  for (const pullRequest of history) {
    const key = pullRequestKey(pullRequest);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(pullRequest);
  }
  return merged;
}
