import {
  Clock,
  GitMerge,
  ListChecks,
  ListTodo,
  PlayCircle,
  Rocket,
  Star,
  UserCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { IssueStateFilter } from "@/hooks/use-issue-filters";
import { LABEL_FILTER_PRESETS } from "@/lib/github/approval-labels";
import type { LabelNavViewId, NavViewId } from "@/types/issue";

export type NavView = {
  id: NavViewId;
  label: string;
  /**
   * ビュー選択時に暗黙で適用するラベル絞り込み（OR一致）。
   * 未指定のビューはラベルでは絞り込まない。
   */
  labels?: readonly string[];
  /**
   * ビュー選択時に暗黙で適用するラベル除外（このいずれかを持つIssueを除く）。
   * labelsとは逆にAND条件で、「未着手」のようにラベルの不在で定義するビュー向け。
   */
  excludeLabels?: readonly string[];
  /**
   * このビューが要求する状態フィルター。stateクエリ未指定時の既定値になるほか、
   * ビュー切り替え時には明示的に選ばれていたstateも上書きして自動で適用する（#475）。
   * 09.mainはマージ完了と同時にissueをcloseする運用（CLAUDE.md）のため、
   * 「直近main反映済み」ビューはopen絞り込みのままだと該当issueが出てこない。
   * お気に入りなど状態を要求しないビューは未指定にし、現在の絞り込み条件を保つ。
   */
  defaultState?: IssueStateFilter;
  /**
   * 最新リリース分だけに絞るビューかどうか。
   * 09.mainは一度付くと外れないラベルのため、これがないと過去の全リリース分が
   * 累積してしまう（詳細はissue-statsのfilterLatestReleaseIssues）。
   */
  latestReleaseOnly?: boolean;
};

const LABEL_NAV_VIEW_ICONS: Record<LabelNavViewId, LucideIcon> = {
  "check-user": UserCheck,
  "not-started": ListTodo,
  "in-progress": PlayCircle,
  "release-pending": Rocket,
  "recently-merged": GitMerge,
};

export const baseNavViews: NavView[] = [
  { id: "all", label: "すべてのIssue" },
  { id: "favorites", label: "お気に入り" },
  { id: "recently-added", label: "最近追加した" },
];

/** 運用ラベルに基づく絞り込みを、他のビューと同じviewクエリで表現するためのビュー定義 */
export const labelNavViews: NavView[] = LABEL_FILTER_PRESETS.map((preset) => ({
  id: preset.key,
  label: preset.label,
  labels: preset.labels,
  excludeLabels: preset.excludeLabels,
  defaultState: preset.state,
  latestReleaseOnly: preset.key === "recently-merged",
}));

/**
 * サイドメニュー「全体」やスマホのクイックビューで選べるビューの一覧。
 * ラベルベースのビューも含め、すべてviewクエリ1つで表現する。
 */
export const navViews: NavView[] = [...baseNavViews, ...labelNavViews];

export const navViewIcons: Record<NavViewId, LucideIcon> = {
  all: ListChecks,
  favorites: Star,
  "recently-added": Clock,
  ...LABEL_NAV_VIEW_ICONS,
};

export function isNavViewId(value: string | null | undefined): value is NavViewId {
  return value !== null && value !== undefined && navViews.some((view) => view.id === value);
}

export function getNavView(id: NavViewId): NavView {
  return navViews.find((view) => view.id === id) ?? baseNavViews[0];
}

export function getNavViewLabel(id: NavViewId): string {
  return getNavView(id).label;
}

/** ビューごとの、stateクエリ未指定時に適用する状態フィルター */
export function getNavViewDefaultState(id: NavViewId): IssueStateFilter {
  return getNavView(id).defaultState ?? "open";
}

/**
 * 指定した並び順（省略時はnavViews）上でidの1つ前・1つ後のビューIDを返す
 * （スマホ一覧のスワイプ切り替え用、#706）。先頭/末尾でそれ以上進められない場合や、
 * idがorderに存在しない場合はnullを返す（ループはしない）。
 *
 * orderを引数で受け取れるようにしているのは、スマホのタブ表示順（#714で
 * 「すべてのIssue」の右隣にユーザーの確認待ちを固定表示するようnavViewsとは
 * 異なる順序に変更済み）とスワイプの前後判定がズレていると、タブ上は隣り合って
 * 見えるビューにスワイプしても切り替わらず順番がおかしく感じられるため（#734）。
 */
export function getAdjacentNavViewId(
  id: NavViewId,
  direction: "prev" | "next",
  order: readonly NavView[] = navViews,
): NavViewId | null {
  const index = order.findIndex((view) => view.id === id);
  if (index === -1) return null;

  const adjacentIndex = direction === "next" ? index + 1 : index - 1;
  return order[adjacentIndex]?.id ?? null;
}

/**
 * ビュー切り替え後に適用すべき状態フィルターを解決する（#475）。
 *
 * - 切り替え先が状態を要求するビュー（「main反映済(直近)」）なら、その状態へ自動で
 *   切り替える。openのままではどう絞り込んでも0件になり、ビューとして成立しないため、
 *   ユーザーが明示的に選んでいた状態よりビューの要求を優先する。
 * - 状態を要求しないビュー（お気に入り等）は現在の絞り込み条件をそのまま引き継ぐ。
 *   ただし直前のビューの要求で決まっていただけの状態（＝明示的に選ばれていない）は、
 *   ユーザーの選択ではないので切り替え先の既定値に戻す。
 * - 同じビューを選び直しただけのときは、明示的な選択を上書きしない。
 *
 * @param isStateExplicit ユーザーが状態を明示的に選んでいるか（URLクエリに残っているか）
 */
export function resolveStateOnViewChange(
  nextView: NavViewId,
  currentView: NavViewId,
  currentState: IssueStateFilter,
  isStateExplicit: boolean,
): IssueStateFilter {
  if (nextView !== currentView) {
    const requiredState = getNavView(nextView).defaultState;
    if (requiredState) return requiredState;
  }
  return isStateExplicit ? currentState : getNavViewDefaultState(nextView);
}
