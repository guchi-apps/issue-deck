import {
  CheckCircle2,
  FolderGit2,
  GitMerge,
  ListChecks,
  PlayCircle,
  Rocket,
  SlidersHorizontal,
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
};

const LABEL_NAV_VIEW_ICONS: Record<LabelNavViewId, LucideIcon> = {
  "check-user": UserCheck,
  "in-progress": PlayCircle,
  "release-pending": Rocket,
  "recently-merged": GitMerge,
};

const baseNavViews: NavView[] = [
  { id: "all", label: "すべてのIssue" },
  { id: "assigned", label: "自分の担当" },
  { id: "created", label: "自分が作成" },
  { id: "favorites", label: "お気に入り" },
  { id: "recent", label: "最近更新されたIssue" },
];

/** 運用ラベルに基づく絞り込みを、他のビューと同じviewクエリで表現するためのビュー定義 */
export const labelNavViews: NavView[] = LABEL_FILTER_PRESETS.map((preset) => ({
  id: preset.key,
  label: preset.label,
  labels: preset.labels,
  defaultState: preset.state,
}));

/**
 * サイドメニュー「全体」やスマホのクイックビューで選べるビューの一覧。
 * ラベルベースのビューも含め、すべてviewクエリ1つで表現する。
 */
export const navViews: NavView[] = [...baseNavViews, ...labelNavViews];

export const navViewIcons: Record<NavViewId, LucideIcon> = {
  all: ListChecks,
  assigned: CheckCircle2,
  created: FolderGit2,
  favorites: Star,
  recent: SlidersHorizontal,
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
