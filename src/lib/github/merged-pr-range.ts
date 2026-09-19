/**
 * 「コードレビュー」ビューのリポジトリ別の枠（#3092）が数える期間まわりの、サーバー・
 * クライアントの両方から使う純粋な部分。
 *
 * **`@/lib/github/request`を経由するもの（`fetchMergedPullRequestCount`等）はここに置かない。**
 * `request.ts`は`api-usage.ts`経由で`node:async_hooks`を読み込むため、クライアント
 * コンポーネント（`issue-list.tsx`等）から値としてインポートするとビルドに失敗する
 * （chunking context does not support external modules）。サーバー専用の処理は
 * `merged-pr-count.ts`に残す。
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
