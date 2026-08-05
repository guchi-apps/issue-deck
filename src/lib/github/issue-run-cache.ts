/**
 * Issue一覧の実行状況ポーリング（`/api/issues/workflow-running`）のためのプロセス内キャッシュ。
 *
 * 実行ログのrunIdはIssueコメント（「実行ログ: ...」）からしか解決できないため、素朴に実装すると
 * ポーリングのたびにコメント一覧の全ページ取得が発生し、GitHub APIの最大の消費源になる。
 * 新しい実行が始まればIssueに実行ログのコメントが増えるので、コメント件数（DBの
 * `Issue.commentCount`。webhookで更新される）が前回解決時から変わっていなければ、解決済みの
 * runIdと完了状態をそのまま再利用できる。
 *
 * webhookの取りこぼしやコメント編集で`commentCount`が変わらないまま状況が変化した場合に備えて、
 * TTLを併用する。本番はPM2のfork（単一プロセス）で動作するためプロセス内で共有でき、プロセスが
 * 入れ替わればキャッシュは空になってGitHub APIから解決し直すだけなので、整合性の問題はない。
 */

/** キャッシュの有効期間。webhookを取りこぼしても、この時間が過ぎれば実際の状態に復帰する */
export const ISSUE_RUN_CACHE_TTL_MS = 5 * 60_000;

/**
 * 実行ログリンクが見つからなかった場合の有効期間。
 * 実行ログのリンクは新規コメントで投稿されるためコメント件数の変化で検知できるが、
 * 既存コメントの編集で追記されるケース（実行中コメントの更新）はコメント件数が変わらない。
 * 「まだ実行ログが無い」状態だけは取りこぼしの影響が大きいため、短めのTTLで確認し直す。
 */
export const ISSUE_RUN_NEGATIVE_CACHE_TTL_MS = 60_000;

/** 保持する最大エントリ数。超えた分は古い順に捨てる（長時間稼働でのメモリ肥大を防ぐ） */
const MAX_ENTRIES = 2000;

export type IssueRunCacheEntry = {
  /** コメントから解決した直近の実行ログrunId。実行ログリンクが無ければnull */
  runId: number | null;
  /** 解決した時点のコメント件数 */
  commentCount: number;
  /** runIdの実行が完了済みかどうか。完了済みならGitHub APIを一切叩かずに応答できる */
  completed: boolean;
  /** キャッシュした時刻（ミリ秒） */
  cachedAt: number;
};

const cache = new Map<string, IssueRunCacheEntry>();

export function issueRunCacheKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

/**
 * コメント件数が一致し、かつTTL内のエントリだけを返す。
 * それ以外（未キャッシュ・コメント増減あり・期限切れ）はnullを返し、呼び出し側で解決し直す。
 */
export function getIssueRunCache(
  key: string,
  commentCount: number,
  now: number = Date.now(),
): IssueRunCacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.commentCount !== commentCount) return null;
  const ttl = entry.runId === null ? ISSUE_RUN_NEGATIVE_CACHE_TTL_MS : ISSUE_RUN_CACHE_TTL_MS;
  if (now - entry.cachedAt >= ttl) return null;
  return entry;
}

export function setIssueRunCache(
  key: string,
  entry: Omit<IssueRunCacheEntry, "cachedAt">,
  now: number = Date.now(),
): void {
  // Mapの挿入順＝古い順を保つため、更新時はいったん削除してから入れ直す
  cache.delete(key);
  cache.set(key, { ...entry, cachedAt: now });

  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** テスト用にキャッシュを空にする */
export function clearIssueRunCache(): void {
  cache.clear();
}
