import type { Issue, LabelSummary, NavViewId, OverviewStat } from "@/types/issue";
import type { IssueFilters, IssueSort } from "@/hooks/use-issue-filters";
import { getNavView, navViews } from "@/lib/nav-views";
import { matchesSearchQuery } from "@/lib/search-query";

const DAY_MS = 1000 * 60 * 60 * 24;
const RECENT_WINDOW_MS = DAY_MS * 7;

/**
 * 同一リリースでcloseされたIssueとみなす、closedAtの許容差。
 * develop→mainのPRがマージされると、対象Issueは1つのworkflow run内で連続して
 * 09.main付与・closeされる（.github/workflows/issue-labels.yml の main-pr-merged）。
 * 実際の間隔は数秒〜数分だが、リリース同士は通常それよりずっと離れているため
 * 1時間を境界とする。
 */
const RELEASE_CLOSE_BATCH_WINDOW_MS = 1000 * 60 * 60;

/**
 * 最新リリースでcloseされたIssueだけを残す。
 * 09.mainは一度付くと外れないため、ラベルだけで絞ると過去の全リリース分が累積する。
 * リポジトリごとにclosedAtの最大値（＝最新リリースのclose時刻）を求め、そこから
 * 一定時間内にcloseされたIssueを同じリリースの分とみなす。
 * closedAtの基準は、検索・状態などの絞り込み前の集合（referenceIssues）から求める。
 */
function filterLatestReleaseIssues(issues: Issue[], referenceIssues: Issue[]): Issue[] {
  const latestClosedAtByRepo = new Map<string, number>();
  for (const issue of referenceIssues) {
    if (!issue.closedAt) continue;
    const closedAt = new Date(issue.closedAt).getTime();
    const latest = latestClosedAtByRepo.get(issue.repositoryFullName);
    if (latest === undefined || closedAt > latest) {
      latestClosedAtByRepo.set(issue.repositoryFullName, closedAt);
    }
  }

  return issues.filter((issue) => {
    if (!issue.closedAt) return false;
    const latest = latestClosedAtByRepo.get(issue.repositoryFullName);
    if (latest === undefined) return false;
    return latest - new Date(issue.closedAt).getTime() <= RELEASE_CLOSE_BATCH_WINDOW_MS;
  });
}

export function filterIssuesByView(
  issues: Issue[],
  view: NavViewId,
  currentUserLogin: string | null,
  // 「最新リリース」の基準時刻を求めるための、絞り込み前の集合（省略時はissuesと同じ）
  referenceIssues: Issue[] = issues,
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
      return issues;
    default: {
      // 運用ラベルに基づくビュー（ユーザーの確認待ち・実行中など）はラベルのOR一致で絞り込む。
      const navView = getNavView(view);
      const viewLabels = navView.labels;
      if (!viewLabels || viewLabels.length === 0) return issues;
      const hasViewLabel = (issue: Issue) =>
        issue.labels.some((label) => viewLabels.includes(label.name));
      const matched = issues.filter(hasViewLabel);
      if (!navView.latestReleaseOnly) return matched;
      return filterLatestReleaseIssues(matched, referenceIssues.filter(hasViewLabel));
    }
  }
}

export function applyIssueFilters(
  issues: Issue[],
  filters: Pick<IssueFilters, "q" | "repo" | "state" | "labels" | "assignee">,
): Issue[] {
  const q = filters.q.trim();

  return issues.filter((issue) => {
    if (q && !matchesSearchQuery(issue, q)) return false;
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

/**
 * ビューごとの件数を数える。
 * ビューのdefaultStateが現在の状態絞り込みと異なる場合（「直近main反映済み」など）は、
 * 選択したときに実際に表示される件数と揃うようissuesIgnoringStateを基準にする。
 */
export function computeNavCounts(
  issues: Issue[],
  issuesIgnoringState: Issue[],
  currentUserLogin: string | null,
  referenceIssues?: Issue[],
): Record<NavViewId, number> {
  const counts = {} as Record<NavViewId, number>;
  for (const view of navViews) {
    const base = view.defaultState === "all" ? issuesIgnoringState : issues;
    counts[view.id] = filterIssuesByView(
      base,
      view.id,
      currentUserLogin,
      referenceIssues ?? base,
    ).length;
  }
  return counts;
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
