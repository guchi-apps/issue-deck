import {
  Clock,
  GitMerge,
  ListChecks,
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
   * stateクエリが未指定のときに適用する状態フィルター（未指定なら"open"）。
   * 09.mainはマージ完了と同時にissueをcloseする運用（CLAUDE.md）のため、
   * 「直近main反映済み」ビューはopen絞り込みのままだと該当issueが出てこない。
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
  "in-progress": PlayCircle,
  "release-pending": Rocket,
  "recently-merged": GitMerge,
};

const baseNavViews: NavView[] = [
  { id: "all", label: "すべてのIssue" },
  { id: "favorites", label: "お気に入り" },
  { id: "recently-added", label: "最近追加した" },
];

/** 運用ラベルに基づく絞り込みを、他のビューと同じviewクエリで表現するためのビュー定義 */
export const labelNavViews: NavView[] = LABEL_FILTER_PRESETS.map((preset) => ({
  id: preset.key,
  label: preset.label,
  labels: preset.labels,
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
