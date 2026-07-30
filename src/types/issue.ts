export type IssueState = "open" | "closed";

export type MockUser = {
  login: string;
};

export type MockRepository = {
  id: string;
  fullName: string;
  name: string;
  private: boolean;
  color: string;
  openIssueCount: number;
  lastActivityLabel: string;
};

export type MockIssueLabel = {
  name: string;
  color: string;
};

export type MockLabelSummary = {
  name: string;
  color: string;
  count: number;
};

export type MockComment = {
  id: string;
  author: MockUser;
  createdAtLabel: string;
  body: string;
  reactionCount: number;
};

export type MockActivity = {
  id: string;
  actorLogin: string;
  description: string;
  createdAtLabel: string;
};

export type MockMilestone = {
  name: string;
  progressPercent: number;
};

export type MockIssue = {
  id: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  repositoryFullName: string;
  author: MockUser;
  assignee: MockUser | null;
  labels: MockIssueLabel[];
  milestone: MockMilestone | null;
  commentCount: number;
  comments: MockComment[];
  activity: MockActivity[];
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
