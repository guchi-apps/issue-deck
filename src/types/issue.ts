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
  htmlUrl: string;
  favorite: boolean;
  hasUnreadComments: boolean;
};

/**
 * 運用ラベル（00.check-userやワークフロー状況ラベル）で絞り込むビューのID。
 * 「自分の担当」などのビューと同じくviewクエリで表現し、URLの持ち方を揃える。
 */
export const LABEL_NAV_VIEW_IDS = [
  "check-user",
  "in-progress",
  "release-pending",
  "recently-merged",
] as const;

export type LabelNavViewId = (typeof LABEL_NAV_VIEW_IDS)[number];

export const NAV_VIEW_IDS = [
  "all",
  "assigned",
  "created",
  "favorites",
  "recent",
  ...LABEL_NAV_VIEW_IDS,
] as const;

export type NavViewId = (typeof NAV_VIEW_IDS)[number];

export type OverviewStat = {
  label: string;
  value: string;
  diffLabel: string;
};
