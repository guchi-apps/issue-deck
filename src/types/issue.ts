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

export type NavViewId =
  | "all"
  | "assigned"
  | "created"
  | "favorites"
  | "recent";

export type OverviewStat = {
  label: string;
  value: string;
  diffLabel: string;
};
