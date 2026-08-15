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
    label: "すべてのPR",
    // マージ済み・クローズ済みを含めていたが、開いているPRだけに絞った（#1613）。左メニューは
    // 「いま動いているもの」を見る場所で、履歴の振り返りはGitHub側で足りるため。マージ済みPRは
    // Issueやブランチ画面のリンクから開けば今までどおり詳細を見られる（#1260）。
    title: "オープンなプルリクエスト",
    description: "開いている全てのPull Request（ドラフト・マージ待ちを含む）",
    emptyMessage: "開いているPull Requestはありません。",
  },
  {
    id: "in-progress",
    label: "実行中",
    title: "実行中のプルリクエスト",
    description: "CIの結果待ちのPull Request（ドラフト・CI状態不明を含む）",
    emptyMessage: "実行中のPull Requestはありません。",
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
 * `prview`クエリ未指定時のビュー。3つの中で母集団がいちばん広い`all`を既定にしている。
 * 画面内のリンクから直接PRを開く経路（#1260）は`prview`を指定しないが、詳細の取得は一覧では
 * なくPRのidで行うため、`all`がopenだけになっても（#1613）マージ済みPRを開ける。
 */
export const DEFAULT_PULL_REQUEST_VIEW: PullRequestViewId = "all";

/**
 * PC左メニュー「Pull Request」セクションに出すビュー（#1613）。
 * 「完了したPR」は外した。CIが確定したPRは「すべてのPR」にマージ待ちとして並び、
 * ユーザーがマージするしかないものは「ユーザーの確認待ち」へ出るため、独立した入口を
 * 持たなくても拾える。`prview=completed`のURLは今までどおり開ける。
 */
export const sidebarPullRequestViews: PullRequestView[] = pullRequestViews.filter((view) =>
  ["all", "in-progress"].includes(view.id),
);

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
