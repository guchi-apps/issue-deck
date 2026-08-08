export type IssueState = "open" | "closed";

export type IssueStateReason = "completed" | "not_planned" | "reopened" | null;

export type GithubUser = {
  login: string;
};

export type IssueLabel = {
  name: string;
  color: string;
  description: string | null;
};

export type LabelSummary = {
  name: string;
  color: string;
  count: number;
};

export type IssueComment = {
  id: string;
  author: GithubUser;
  createdAtLabel: string;
  body: string;
  reactionCount: number;
};

export type IssueMilestone = {
  name: string;
  progressPercent: number;
};

export type Issue = {
  id: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  stateReason: IssueStateReason;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  repositoryArchived: boolean;
  author: GithubUser;
  assignee: GithubUser | null;
  labels: IssueLabel[];
  milestone: IssueMilestone | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  /** closeされた日時（ISO8601）。openなIssueはnull */
  closedAt: string | null;
  /** 00.check-userラベルが最後に付与された日時（ISO8601）。未付与・解除済みはnull */
  checkUserLabeledAt: string | null;
  /**
   * 「Claudeに質問する」ダイアログ経由の質問コメントが投稿された日時（ISO8601）。
   * 対応する回答コメントが投稿されると解除されnullに戻る。一覧向けのDBキャッシュ由来の
   * 近似値（詳細画面ではコメント全件から@/lib/github/ask-claudeのisQaAnswerPendingで
   * 正確に算出する）
   */
  qaAnswerPendingAt: string | null;
  /** 実際に最後にコメントが投稿された日時（ISO8601）。Webhook経由で未取得の場合はnull */
  lastCommentAt: string | null;
  htmlUrl: string;
  favorite: boolean;
  hasUnreadComments: boolean;
  /** ユーザーが最後に読んだ時点でのコメント総数。「ページ下部へ移動」ボタンで最初の未読コメントへ移動するために使う */
  readCommentCount: number;
};

/**
 * 運用ラベル（00.check-userやワークフロー状況ラベル）で絞り込むビューのID。
 * 「自分の担当」などのビューと同じくviewクエリで表現し、URLの持ち方を揃える。
 */
export const LABEL_NAV_VIEW_IDS = [
  "check-user",
  "not-started",
  "in-progress",
  "release-pending",
  "recently-merged",
] as const;

export type LabelNavViewId = (typeof LABEL_NAV_VIEW_IDS)[number];

export const NAV_VIEW_IDS = [
  "all",
  "favorites",
  "recently-added",
  ...LABEL_NAV_VIEW_IDS,
] as const;

export type NavViewId = (typeof NAV_VIEW_IDS)[number];

export type OverviewStat = {
  label: string;
  value: string;
  diffLabel: string;
  /** 指定時、カードをタップすると遷移する先のクイックビュー */
  linkedView?: NavViewId;
};
