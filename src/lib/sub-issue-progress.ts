import {
  PROGRESS_STATUSES,
  resolveProgressStatus,
  type ProgressStatusKey,
} from "@/lib/issue-progress";
import type { SubIssue } from "@/types/issue";

/**
 * 子Issueの進捗を親から見て集計する。
 *
 * **進捗の正はProject Status**（docs/progress-status-architecture.md）なので、GitHubネイティブの
 * `subIssuesSummary.completed`（close済み件数）ではなく`resolveProgressStatus`で解決した状態を
 * 内訳として出す。「4件中3件closed」だけだと、残り1件が未着手なのか実装中なのかが分からない。
 */

/** 内訳1行。件数0の状態は含めない */
export type SubIssueProgressBucket = {
  key: ProgressStatusKey;
  count: number;
};

export type SubIssueProgressSummary = {
  /** 子Issueの総件数 */
  total: number;
  /** 終わっている件数（下記の判定） */
  done: number;
  /** 完了率（0〜100の整数）。子が0件なら0 */
  percent: number;
  /** 進捗の遷移順に並んだ内訳。件数0の状態は含まない */
  buckets: SubIssueProgressBucket[];
};

/**
 * 子Issue1件の進捗状態を解決する。
 *
 * **closeされている子は、Statusが何であっても`done`として数える。** Statusが`Done`まで
 * 進まずにcloseされる経路（`not planned`でのclose・分割元のclose・重複としてのclose）が
 * 実際にあり、親から見ればどれも「もう残っていない」ため。
 */
export function resolveSubIssueProgress(child: SubIssue): ProgressStatusKey {
  if (child.state === "closed") return "done";
  return resolveProgressStatus(child);
}

/** 終わっているかどうか。closeされているか、Statusが`done`（mainへ反映済み）なら終わり */
export function isSubIssueDone(child: SubIssue): boolean {
  return resolveSubIssueProgress(child) === "done";
}

export function summarizeSubIssueProgress(children: SubIssue[]): SubIssueProgressSummary {
  const counts = new Map<ProgressStatusKey, number>();
  let done = 0;

  for (const child of children) {
    const key = resolveSubIssueProgress(child);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (key === "done") done += 1;
  }

  // PROGRESS_STATUSESの並びがそのまま遷移順。Mapの挿入順に依存させない
  const buckets = PROGRESS_STATUSES.map((status) => ({
    key: status.key,
    count: counts.get(status.key) ?? 0,
  })).filter((bucket) => bucket.count > 0);

  const total = children.length;
  return {
    total,
    done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    buckets,
  };
}
