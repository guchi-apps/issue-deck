import type { IssueStateFilter } from "@/hooks/use-issue-filters";
import { getNavViewDefaultState } from "@/lib/nav-views";
import type { NavViewId } from "@/types/issue";

/** 一覧の件数を減らす（＝Issueを隠す）絞り込み条件 */
export type IssueFilterConditions = {
  state: IssueStateFilter;
  labels: string[];
  assignee: string | null;
};

/**
 * いま効いている絞り込み条件の数（#1645）。スマホの絞り込みボタンのバッジに出し、
 * 「件数が少ないのは絞り込んでいるからだ」と画面から読み取れるようにする。
 *
 * **数えるのは一覧からIssueを隠す条件だけ**で、並び順・リポジトリごとのグルーピングは
 * 同じシートの中にあっても数えない（表示順が変わるだけで件数は変わらないため、
 * バッジの数と「見えていないIssueがある度合い」が食い違ってしまう）。
 *
 * 状態（open/closed/all）はビューごとに既定値が違う（「直近本番に反映した」はall）ため、
 * ビューの既定値と違うときだけ1件として数える。
 */
export function countActiveIssueFilters(
  filters: IssueFilterConditions,
  view: NavViewId,
): number {
  let count = 0;
  if (filters.state !== getNavViewDefaultState(view)) count += 1;
  count += filters.labels.length;
  if (filters.assignee !== null) count += 1;
  return count;
}

/**
 * 「すべて解除」で戻す条件（#1645）。`countActiveIssueFilters`が数える条件だけを
 * 既定へ戻し、並び順・グルーピングはユーザーの選択として残す。
 */
export function clearIssueFilterConditions<T extends IssueFilterConditions>(
  filters: T,
  view: NavViewId,
): T {
  return {
    ...filters,
    state: getNavViewDefaultState(view),
    labels: [],
    assignee: null,
  };
}
