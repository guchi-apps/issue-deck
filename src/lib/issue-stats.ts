import type { Issue, LabelSummary, NavViewId, OverviewStat } from "@/types/issue";

const DAY_MS = 1000 * 60 * 60 * 24;

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
      // お気に入り登録機能は未実装のため常に空。
      return [];
    case "recent":
      return [...issues].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    case "all":
    default:
      return issues;
  }
}

export function computeNavCounts(
  issues: Issue[],
  currentUserLogin: string | null,
): Record<NavViewId, number> {
  return {
    all: issues.length,
    assigned: issues.filter((issue) => issue.assignee?.login === currentUserLogin).length,
    created: issues.filter((issue) => issue.author.login === currentUserLogin).length,
    favorites: 0,
    recent: issues.length,
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
