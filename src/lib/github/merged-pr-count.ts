import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * 「コードレビュー」ビューのリポジトリ別の枠（#3092）に出す、ある期間に入った（マージされた）
 * PRの件数。
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

/** 数える期間。`to`が`null`なら「`from`から今まで」 */
export type MergedPullRequestRange = {
  repositoryFullName: string;
  /** ISO8601。この時刻以降にマージされたものを数える */
  from: string;
  /** ISO8601。この時刻までにマージされたものを数える。`null`なら今まで */
  to: string | null;
};

/**
 * 期間を1つの文字列にする。画面とAPIのあいだで期間を受け渡すキーで、戻り値の引き当てにも使う。
 * `|`はリポジトリ名にもISO8601にも現れないので区切りに使える。
 */
export function mergedPullRequestRangeKey(range: MergedPullRequestRange): string {
  return `${range.repositoryFullName}|${range.from}|${range.to ?? ""}`;
}

/** `mergedPullRequestRangeKey`の逆。形が違うもの・時刻として読めないものは`null` */
export function parseMergedPullRequestRangeKey(value: string): MergedPullRequestRange | null {
  const [repositoryFullName, from, to, ...rest] = value.split("|");
  if (rest.length > 0 || to === undefined) return null;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repositoryFullName)) return null;
  if (!isIsoTimestamp(from)) return null;
  if (to !== "" && !isIsoTimestamp(to)) return null;
  return { repositoryFullName, from, to: to === "" ? null : to };
}

function isIsoTimestamp(value: string): boolean {
  // 検索クエリへそのまま埋めるので、空白や引用符を含む値は通さない
  return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * 検索クエリ。**ミリ秒は落とす**——GitHubの日時の修飾子は秒までしか受け付けない。
 * `A..B`は両端を含むため、境目ちょうどにマージされたPRは隣り合う2つの期間の両方に入りうるが、
 * 秒単位で一致することはまず無いので扱わない。
 */
export function buildMergedPullRequestQuery(
  range: MergedPullRequestRange,
  baseBranch: string,
): string {
  const from = toSearchTimestamp(range.from);
  const merged = range.to === null ? `>=${from}` : `${from}..${toSearchTimestamp(range.to)}`;
  return `repo:${range.repositoryFullName} is:pr is:merged base:${baseBranch} merged:${merged}`;
}

function toSearchTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

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
