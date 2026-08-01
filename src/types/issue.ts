export type IssueState = "open" | "closed";

export type GithubUser = {
  login: string;
};

export type IssueLabel = {
  name: string;
  color: string;
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
