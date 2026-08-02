import type { Issue, LabelSummary, NavViewId, OverviewStat } from "@/types/issue";
import type { IssueFilters, IssueSort } from "@/hooks/use-issue-filters";
import { getWorkflowStepIndex, WORKFLOW_STEPS } from "@/lib/github/workflow-status";

/** ワークフロー進行中とみなす最後のindex（09.mainは完了状態のため対象外） */
const IN_PROGRESS_MAX_STEP_INDEX = WORKFLOW_STEPS.length - 2;

const DAY_MS = 1000 * 60 * 60 * 24;
const RECENT_WINDOW_MS = DAY_MS * 7;

export function filterIssuesByView(
  issues: Issue[],
  view: NavViewId,
  currentUserLogin: string | null,
): Issue[] {
  switch (view) {
    case "assigned":
      return issues.filter((issue) => issue.assignee?.login === currentUserLogin);
    case "created":
      return issues.filter((issue) => issue.author.login === currentUserLogin);
    case "favorites":
      return issues.filter((issue) => issue.favorite);
    case "recent":
      return issues.filter(
        (issue) => Date.now() - new Date(issue.updatedAt).getTime() < RECENT_WINDOW_MS,
      );
    case "all":
    default:
      return issues;
  }
}

export function applyIssueFilters(
  issues: Issue[],
  filters: Pick<IssueFilters, "q" | "repo" | "state" | "labels" | "assignee" | "inProgressOnly">,
): Issue[] {
  const keyword = filters.q.trim().toLowerCase();

  return issues.filter((issue) => {
    if (keyword) {
      const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.repo && issue.repositoryFullName !== filters.repo) return false;
    if (filters.state !== "all" && issue.state !== filters.state) return false;
    if (filters.labels.length > 0) {
      const issueLabelNames = new Set(issue.labels.map((label) => label.name));
      if (!filters.labels.some((name) => issueLabelNames.has(name))) return false;
    }
    if (filters.assignee) {
      if (filters.assignee === "unassigned") {
        if (issue.assignee) return false;
      } else if (issue.assignee?.login !== filters.assignee) {
        return false;
      }
    }
    if (filters.inProgressOnly) {
      const stepIndex = getWorkflowStepIndex(issue.labels);
      if (stepIndex === null || stepIndex > IN_PROGRESS_MAX_STEP_INDEX) return false;
    }
    return true;
  });
}

export function sortIssues(issues: Issue[], sort: IssueSort): Issue[] {
  const key: keyof Pick<Issue, "updatedAt" | "createdAt"> =
    sort === "created" ? "createdAt" : "updatedAt";
  return [...issues].sort(
    (a, b) => new Date(b[key]).getTime() - new Date(a[key]).getTime(),
  );
}

export function getAssigneeOptions(issues: Issue[]): string[] {
  const logins = new Set<string>();
  for (const issue of issues) {
    if (issue.assignee) logins.add(issue.assignee.login);
  }
  return [...logins].sort();
}

export function computeNavCounts(
  issues: Issue[],
  currentUserLogin: string | null,
): Record<NavViewId, number> {
  return {
    all: issues.length,
    assigned: issues.filter((issue) => issue.assignee?.login === currentUserLogin).length,
    created: issues.filter((issue) => issue.author.login === currentUserLogin).length,
    favorites: issues.filter((issue) => issue.favorite).length,
    recent: issues.filter(
      (issue) => Date.now() - new Date(issue.updatedAt).getTime() < RECENT_WINDOW_MS,
    ).length,
  };
}

export function computeOverviewStats(
  issues: Issue[],
  currentUserLogin: string | null,
): OverviewStat[] {
  const openCount = issues.filter((issue) => issue.state === "open").length;
  const assignedOpenCount = issues.filter(
    (issue) => issue.state === "open" && issue.assignee?.login === currentUserLogin,
  ).length;
  const updatedRecentlyCount = issues.filter(
    (issue) => Date.now() - new Date(issue.updatedAt).getTime() < DAY_MS,
  ).length;

  return [
    { label: "オープンIssue", value: String(openCount), diffLabel: "" },
    { label: "担当中", value: String(assignedOpenCount), diffLabel: "" },
    { label: "24時間以内の更新", value: `${updatedRecentlyCount}件`, diffLabel: "" },
  ];
}

// ポーリング等で取得した最新のIssue一覧を、内容が変わっていないIssueについては
// 直前のオブジェクト参照を再利用してマージする。これにより、ポーリングのたびに
// 全Issueのオブジェクト参照が入れ替わることで発生する不要な再レンダリング・副作用の
// 再実行（コメント欄の一瞬の再読み込み表示など）を防ぐ。
export function reconcileIssues(prevIssues: Issue[], nextIssues: Issue[]): Issue[] {
  const prevById = new Map(prevIssues.map((issue) => [issue.id, issue] as const));
  return nextIssues.map((issue) => {
    const prevIssue = prevById.get(issue.id);
    return prevIssue && isIssueContentEqual(prevIssue, issue) ? prevIssue : issue;
  });
}

function isIssueContentEqual(a: Issue, b: Issue): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.state === b.state &&
    a.commentCount === b.commentCount &&
    a.updatedAt === b.updatedAt &&
    a.favorite === b.favorite &&
    a.hasUnreadComments === b.hasUnreadComments &&
    a.htmlUrl === b.htmlUrl &&
    a.assignee?.login === b.assignee?.login &&
    a.milestone?.name === b.milestone?.name &&
    a.milestone?.progressPercent === b.milestone?.progressPercent &&
    a.labels.length === b.labels.length &&
    a.labels.every((label, i) => label.name === b.labels[i]?.name && label.color === b.labels[i]?.color)
  );
}

export function computeLabelSummary(issues: Issue[]): LabelSummary[] {
  const summaryByName = new Map<string, LabelSummary>();

  for (const issue of issues) {
    for (const label of issue.labels) {
      const existing = summaryByName.get(label.name);
      if (existing) {
        existing.count += 1;
      } else {
        summaryByName.set(label.name, { name: label.name, color: label.color, count: 1 });
      }
    }
  }

  return [...summaryByName.values()].sort((a, b) => b.count - a.count);
}
