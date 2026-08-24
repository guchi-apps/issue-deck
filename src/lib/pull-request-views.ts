import { GitMerge, GitPullRequest, LoaderCircle } from "lucide-react";
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
    // Claudeのレビュー・自動マージ可否の判定が動いている間もここに入る（#2283）。CI状態とは
    // 別の軸なので、「CIの結果待ち」だけだと「CI通過」と出ているPRがここにいる理由を読めない。
    description:
      "CIの結果待ち・Claudeのレビュー中／マージ可否の判定中のPull Request（ドラフト・CI状態不明を含む）",
    emptyMessage: "実行中のPull Requestはありません。",
  },
  {
    id: "completed",
    // 「完了したPR」から改名した（#2120）。CIが確定しただけで何も完了しておらず、名前が
    // 「マージ済み」とも読めていた。ビューのidは`prview=completed`のURLを生かすため変えない。
    label: "マージ待ち",
    title: "マージ待ちのプルリクエスト",
    // CI失敗を含むことを明示する。「ユーザーの確認待ち」に並ぶPR（`requiresUserMerge`）とは
    // 母集団が別で、あちらはCIの結果を見ないため、CI実行中のリリースPRはここには出ない。
    // 判定が動いている間は「実行中」側にいる（#2283）。
    description:
      "CIも自動マージ可否の判定も終わり、マージを待っているPull Request（CI失敗を含む。「ユーザーの確認待ち」とは母集団が別）",
    emptyMessage: "マージ待ちのPull Requestはありません。",
  },
];

/**
 * `prview`クエリ未指定時のビュー。3つの中で母集団がいちばん広い`all`を既定にしている。
 * 画面内のリンクから直接PRを開く経路（#1260）は`prview`を指定しないが、詳細の取得は一覧では
 * なくPRのidで行うため、`all`がopenだけになっても（#1613）マージ済みPRを開ける。
 */
export const DEFAULT_PULL_REQUEST_VIEW: PullRequestViewId = "all";

/**
 * PC左メニュー・スマホホームの「Pull Request」セクションに出すビュー（#1613・#2120）。
 *
 * #1613で「完了したPR」を外し、CIが確定したPRは「すべてのPR」から拾う前提にしていたが、
 * そこには実行中のPRも混ざるため「あとはマージするだけのPR」だけを見る入口が無かった。
 * 「マージ待ち」へ改名したうえで戻し、3つとも並べる（#2120）。`filterPullRequestsByView`が
 * 「実行中」と「マージ待ち」でopenなPRを二分するので、2つの件数の和は「すべてのPR」に一致する。
 */
export const sidebarPullRequestViews: PullRequestView[] = pullRequestViews;

export const pullRequestViewIcons: Record<PullRequestViewId, LucideIcon> = {
  all: GitPullRequest,
  "in-progress": LoaderCircle,
  // チェックマーク（`CircleCheckBig`）だと「マージ済み」に読めるため、マージの記号にした（#2120）。
  completed: GitMerge,
};

export function isPullRequestViewId(value: string | null | undefined): value is PullRequestViewId {
  return value !== null && value !== undefined && pullRequestViews.some((view) => view.id === value);
}

export function getPullRequestView(id: PullRequestViewId): PullRequestView {
  return pullRequestViews.find((view) => view.id === id) ?? pullRequestViews[0];
}

/**
 * 表示順で隣にあるビューのidを返す（端に来たらnull）。スマホのPR一覧を左右にスワイプして
 * ビューを切り替えるのに使う（#1691）。Issue側の`getAdjacentNavViewId`と同じ形。
 */
export function getAdjacentPullRequestViewId(
  id: PullRequestViewId,
  direction: "prev" | "next",
  order: readonly PullRequestView[] = pullRequestViews,
): PullRequestViewId | null {
  const index = order.findIndex((view) => view.id === id);
  if (index === -1) return null;

  const adjacentIndex = direction === "next" ? index + 1 : index - 1;
  return order[adjacentIndex]?.id ?? null;
}
