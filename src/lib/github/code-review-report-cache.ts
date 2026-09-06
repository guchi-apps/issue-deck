import type { CodeReviewSummary } from "@/lib/github/code-review";

/**
 * 「コードレビュー」ビューの一覧に出す結果要約（#2855）のためのプロセス内キャッシュ。
 *
 * レビュー結果はIssueコメントにしか無いため、一覧の行に件数を出すにはレビューIssue1件につき
 * コメント一覧をGitHubから取る必要がある。**結果が返った後の要約は動かない**ので、
 * コメント件数（DBの`Issue.commentCount`。webhookで更新される）が前回と同じなら、
 * 解決済みの要約をそのまま使い回せる。考え方も形も`issue-run-cache.ts`と同じ。
 *
 * webhookの取りこぼしやコメント編集で`commentCount`が変わらないまま結果が変わった場合に備えて
 * TTLを併用する。本番はPM2のfork（単一プロセス）で動くのでプロセス内で共有でき、プロセスが
 * 入れ替わればGitHubから解決し直すだけなので整合性の問題はない。
 */

/** 結果が返っているレビューの有効期間。要約はもう動かないので長めでよい */
export const CODE_REVIEW_SUMMARY_CACHE_TTL_MS = 5 * 60_000;

/**
 * 結果がまだ返っていないレビュー（`pending`・`missing`）の有効期間。
 *
 * 結果は新規コメントとして返るためコメント件数の変化で気付けるが、webhookを取りこぼすと
 * 「レビュー中」のまま張り付く。走っている最中だけは短い間隔で確認し直す。
 */
export const CODE_REVIEW_SUMMARY_PENDING_CACHE_TTL_MS = 60_000;

/** 保持する最大エントリ数。超えた分は古い順に捨てる（長時間稼働でのメモリ肥大を防ぐ） */
const MAX_ENTRIES = 500;

export type CodeReviewSummaryCacheEntry = {
  summary: CodeReviewSummary;
  /** 解決した時点のコメント件数 */
  commentCount: number;
  /** キャッシュした時刻（ミリ秒） */
  cachedAt: number;
};

const cache = new Map<string, CodeReviewSummaryCacheEntry>();

export function codeReviewSummaryCacheKey(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return `${owner}/${repo}#${issueNumber}`;
}

/**
 * コメント件数が一致し、かつTTL内のエントリだけを返す。
 * それ以外（未キャッシュ・コメント増減あり・期限切れ）はnullを返し、呼び出し側で解決し直す。
 */
export function getCodeReviewSummaryCache(
  key: string,
  commentCount: number,
  now: number = Date.now(),
): CodeReviewSummary | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.commentCount !== commentCount) return null;
  const ttl =
    entry.summary.state === "reported"
      ? CODE_REVIEW_SUMMARY_CACHE_TTL_MS
      : CODE_REVIEW_SUMMARY_PENDING_CACHE_TTL_MS;
  if (now - entry.cachedAt >= ttl) return null;
  return entry.summary;
}

export function setCodeReviewSummaryCache(
  key: string,
  entry: Omit<CodeReviewSummaryCacheEntry, "cachedAt">,
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
export function clearCodeReviewSummaryCache(): void {
  cache.clear();
}
