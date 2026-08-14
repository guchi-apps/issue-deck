import { CircleCheckBig, GitPullRequest, LoaderCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { PullRequestViewId } from "@/types/pull-request";

export type PullRequestView = {
  id: PullRequestViewId;
  /** 左メニュー・スマホホームでの表示名。サイドバーの既定幅（240px）に収まる長さにする */
  label: string;
  /** 一覧ヘッダーの見出し。メニューより広いので、何を集めた画面かが分かる長さにする */
  title: string;
  /** 判定条件の補足。メニュー項目のtitle属性に使う */
  description: string;
  /** 一覧が0件のときの文言。`title`からの機械的な生成だと日本語として不自然になるため個別に持つ */
  emptyMessage: string;
};

/**
 * 左メニュー「Pull Request」セクションの状態別ビュー（#1312）。
 *
 * Issue側の`lib/nav-views.ts`と同じ形（定義配列＋アイコンのマップ）にしてある。ビューの判定
 * ロジック自体は`lib/pull-request-list.ts`の純粋関数側にあり、ここは表示名だけを持つ。
 */
export const pullRequestViews: PullRequestView[] = [
  {
    id: "all",
    label: "全てのPR",
    title: "全てのプルリクエスト",
    description: "マージ済み・クローズ済みを含む全てのPull Request",
    emptyMessage: "Pull Requestはありません。",
  },
  {
    id: "in-progress",
    label: "処理中のPR",
    title: "処理中のプルリクエスト",
    description: "CIの結果待ちのPull Request（ドラフト・CI状態不明を含む）",
    emptyMessage: "処理中のPull Requestはありません。",
  },
  {
    id: "completed",
    label: "完了したPR",
    title: "処理が完了したプルリクエスト",
    description: "CIが確定したPull Request（マージできる状態、または失敗しているもの）",
    emptyMessage: "処理が完了したPull Requestはありません。",
  },
];

/**
 * `prview`クエリ未指定時のビュー。画面内のリンクから直接PRを開く経路（#1260）は`prview`を
 * 指定しないため、マージ済みでも一覧に載る`all`を既定にしている。
 */
export const DEFAULT_PULL_REQUEST_VIEW: PullRequestViewId = "all";

export const pullRequestViewIcons: Record<PullRequestViewId, LucideIcon> = {
  all: GitPullRequest,
  "in-progress": LoaderCircle,
  completed: CircleCheckBig,
};

export function isPullRequestViewId(value: string | null | undefined): value is PullRequestViewId {
  return value !== null && value !== undefined && pullRequestViews.some((view) => view.id === value);
}

export function getPullRequestView(id: PullRequestViewId): PullRequestView {
  return pullRequestViews.find((view) => view.id === id) ?? pullRequestViews[0];
}
