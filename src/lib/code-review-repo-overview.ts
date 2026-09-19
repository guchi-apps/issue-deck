import { isCodeReviewIssue } from "@/lib/github/code-review";
import type { MergedPullRequestRange } from "@/lib/github/merged-pr-range";
import type { Issue } from "@/types/issue";

/**
 * 「コードレビュー」ビューの先頭に置くリポジトリ別の枠（#3092）の組み立て。
 *
 * 一覧はレビューIssueが時系列に並ぶだけで、**どのリポジトリをいつレビューしたか・しばらく
 * レビューしていないのはどこか**が読み取れなかった。ここではレビューIssueをリポジトリごとに
 * 束ね、前回の実施日・回数・直近の実施時期（帯の点）と、前回以降に入ったPRを数える期間を返す。
 *
 * **実施日はレビューIssueの作成日時で数える**（タイトルの日付は日本時間の日付だけで、同じ日に
 * 2回回すと区別できない）。**状態で絞る前の集合を渡すこと**——一覧はopen（#3141）だけを並べる
 * ので、close済みの古いレビューも、実施の記録としては数える。
 */

/** 帯に出す期間。12週（84日） */
export const CODE_REVIEW_TIMELINE_DAYS = 84;

/** これより空いたリポジトリは注意の色で出す */
export const CODE_REVIEW_STALE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CodeReviewRepoReview = {
  issueId: string;
  createdAt: string;
  /** 結果がまだ返っていない（帯では白抜きで出す） */
  pending: boolean;
};

export type CodeReviewRepoRow = {
  repositoryFullName: string;
  /** 古い順 */
  reviews: CodeReviewRepoReview[];
  lastReviewedAt: string | null;
  /** 前回からの経過日数（切り捨て）。未実施は`null` */
  daysSinceLast: number | null;
  /** 30日以上空いた・未実施 */
  stale: boolean;
  /** サブPCでいまレビューを実行できるか（「実行」を出すか） */
  canRun: boolean;
  /**
   * 帯に出す点。`position`は帯の左端（12週前）を0、右端（今）を1とした位置。
   * 12週より前のレビューは入らない
   */
  dots: { issueId: string; position: number; pending: boolean }[];
};

/**
 * リポジトリ別の行を組み立てる。
 *
 * - 載せるのは「いまレビューを実行できる」か「過去にレビューしたことがある」リポジトリ。
 *   `repositoryFullNames`は画面に出してよい（非表示にしていない）リポジトリの一覧で、
 *   ここに無いリポジトリのレビューは載せない
 * - 並びは前回からの経過が長い順。**未実施が先頭**（名前順）
 */
export function buildCodeReviewRepoRows(params: {
  reviewIssues: readonly Issue[];
  repositoryFullNames: readonly string[];
  canRun: (repositoryFullName: string) => boolean;
  isPending: (issue: Issue) => boolean;
  now: number;
}): CodeReviewRepoRow[] {
  const { reviewIssues, repositoryFullNames, canRun, isPending, now } = params;
  const visible = new Set(repositoryFullNames);

  const reviewsByRepo = new Map<string, CodeReviewRepoReview[]>();
  for (const issue of reviewIssues) {
    if (!isCodeReviewIssue(issue) || !visible.has(issue.repositoryFullName)) continue;
    if (Number.isNaN(Date.parse(issue.createdAt))) continue;
    const list = reviewsByRepo.get(issue.repositoryFullName) ?? [];
    list.push({ issueId: issue.id, createdAt: issue.createdAt, pending: isPending(issue) });
    reviewsByRepo.set(issue.repositoryFullName, list);
  }

  const windowStart = now - CODE_REVIEW_TIMELINE_DAYS * DAY_MS;
  const rows: CodeReviewRepoRow[] = [];
  for (const repositoryFullName of visible) {
    const reviews = (reviewsByRepo.get(repositoryFullName) ?? []).sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    const runnable = canRun(repositoryFullName);
    if (reviews.length === 0 && !runnable) continue;

    const last = reviews.at(-1) ?? null;
    const daysSinceLast = last
      ? Math.max(0, Math.floor((now - Date.parse(last.createdAt)) / DAY_MS))
      : null;
    rows.push({
      repositoryFullName,
      reviews,
      lastReviewedAt: last?.createdAt ?? null,
      daysSinceLast,
      stale: daysSinceLast === null || daysSinceLast >= CODE_REVIEW_STALE_DAYS,
      canRun: runnable,
      dots: reviews
        .filter((review) => Date.parse(review.createdAt) >= windowStart)
        .map((review) => ({
          issueId: review.issueId,
          position: Math.min(1, (Date.parse(review.createdAt) - windowStart) / (now - windowStart)),
          pending: review.pending,
        })),
    });
  }

  return rows.sort((a, b) => {
    if (a.lastReviewedAt === null || b.lastReviewedAt === null) {
      if (a.lastReviewedAt !== b.lastReviewedAt) return a.lastReviewedAt === null ? -1 : 1;
      return a.repositoryFullName.localeCompare(b.repositoryFullName);
    }
    return Date.parse(a.lastReviewedAt) - Date.parse(b.lastReviewedAt);
  });
}

/** 前回のレビューから今までに入ったPRを数える期間。未実施なら`null` */
export function sinceLastReviewRange(row: CodeReviewRepoRow): MergedPullRequestRange | null {
  if (row.lastReviewedAt === null) return null;
  return {
    repositoryFullName: row.repositoryFullName,
    from: new Date(row.lastReviewedAt).toISOString(),
    to: null,
  };
}

/**
 * レビュー1件ごとの「ひとつ前のレビューからこのレビューまで」の期間（`issueId`で引く）。
 * そのリポジトリで最初のレビューには期間が無く、入らない（画面は「初回」と出す）。
 */
export function reviewIntervalRanges(
  row: CodeReviewRepoRow,
): Map<string, MergedPullRequestRange> {
  const ranges = new Map<string, MergedPullRequestRange>();
  row.reviews.forEach((review, index) => {
    if (index === 0) return;
    ranges.set(review.issueId, {
      repositoryFullName: row.repositoryFullName,
      from: new Date(row.reviews[index - 1].createdAt).toISOString(),
      to: new Date(review.createdAt).toISOString(),
    });
  });
  return ranges;
}
