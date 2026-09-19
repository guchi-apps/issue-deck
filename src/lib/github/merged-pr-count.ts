import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  buildMergedPullRequestQuery,
  mergedPullRequestRangeKey,
  parseMergedPullRequestRangeKey,
  type MergedPullRequestRange,
} from "@/lib/github/merged-pr-range";

export {
  buildMergedPullRequestQuery,
  mergedPullRequestRangeKey,
  parseMergedPullRequestRangeKey,
  type MergedPullRequestRange,
};

/**
 * 「コードレビュー」ビューのリポジトリ別の枠（#3092）に出す、ある期間に入った（マージされた）
 * PRの件数。**サーバー専用**（`@/lib/github/request`経由で`node:async_hooks`を読み込むため）。
 * 期間の型・キーの組み立てなどクライアントからも使う部分は`merged-pr-range.ts`にある。
 *
 * **PRの一覧を引いて数えず、検索APIの`total_count`だけを読む。** issue-deckのように週100件近く
 * 入るリポジトリでは、一覧を引くと前回のレビューまで何ページも遡ることになる。検索なら期間1つに
 * つき1リクエストで済む。
 *
 * **数えるのはリポジトリの既定ブランチ（fleetでは`develop`）へ入ったPRだけ。** develop→main
 * のリリースPRは中身が既にdevelopへ入ったPRの束で、数えると同じ変更を二重に数える。
 * リリースPRのheadは`release-main/vX.Y.Z`で（以前は`develop`）、headでは除けないため
 * baseで絞る。`develop`を持たないリポジトリは既定ブランチが`main`なので、そのまま数えられる。
 * リリースのたびにdevelopへ入るバージョン更新のPR（`release/vX.Y.Z`→develop）は数に入る。
 */

/** 件数を1つ取る。取れなければ`null`（画面は「—」を出す） */
export async function fetchMergedPullRequestCount(
  range: MergedPullRequestRange,
  baseBranch: string,
  token: string,
): Promise<number | null> {
  const query = buildMergedPullRequestQuery(range, baseBranch);
  const res = await githubFetch(
    `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
    token,
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { total_count?: unknown };
  return typeof json.total_count === "number" ? json.total_count : null;
}

/**
 * 件数のプロセス内キャッシュ。**検索APIは30回/分の制限がある**ので、一覧を開き直すたびに
 * 引き直さない。
 *
 * - 終わりのある期間（ひとつ前のレビュー〜そのレビュー）は過去のことで、後から増えない。
 *   上限まで持ち続ける
 * - 「前回から今まで」は増えていくので10分で捨てる
 */
const OPEN_RANGE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { count: number; fetchedAt: number }>();

/** キャッシュのキー。既定ブランチが変わったら別物として数え直す */
function cacheKey(range: MergedPullRequestRange, baseBranch: string): string {
  return `${mergedPullRequestRangeKey(range)}|${baseBranch}`;
}

export function getMergedPullRequestCountCache(
  range: MergedPullRequestRange,
  baseBranch: string,
  now: number = Date.now(),
): number | null {
  const entry = cache.get(cacheKey(range, baseBranch));
  if (!entry) return null;
  if (range.to === null && now - entry.fetchedAt > OPEN_RANGE_TTL_MS) return null;
  return entry.count;
}

export function setMergedPullRequestCountCache(
  range: MergedPullRequestRange,
  baseBranch: string,
  count: number,
  now: number = Date.now(),
): void {
  const key = cacheKey(range, baseBranch);
  cache.delete(key);
  cache.set(key, { count, fetchedAt: now });
  // 古いものから捨てる（Mapは挿入順を保つ）
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** テスト用 */
export function clearMergedPullRequestCountCache(): void {
  cache.clear();
}
