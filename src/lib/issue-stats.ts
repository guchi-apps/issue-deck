import type { Issue, LabelSummary, NavViewId, OverviewStat } from "@/types/issue";
import type { IssueFilters, IssueSort } from "@/hooks/use-issue-filters";
import { CHECK_USER_LABEL } from "@/lib/github/approval-labels";
import { MAIN_MERGED_LABEL_NAME } from "@/lib/github/workflow-status";
import { getNavView, navViews } from "@/lib/nav-views";
import { matchesSearchQuery } from "@/lib/search-query";

const DAY_MS = 1000 * 60 * 60 * 24;
const RECENTLY_ADDED_WINDOW_MS = DAY_MS;

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
    case "favorites":
      return issues.filter((issue) => issue.favorite);
    case "recently-added":
      return issues.filter(
        (issue) => Date.now() - new Date(issue.createdAt).getTime() < RECENTLY_ADDED_WINDOW_MS,
      );
    case "all":
      return issues;
    default: {
      // 運用ラベルに基づくビュー（ユーザーの確認待ち・実行中など）はラベルのOR一致で、
      // 「未着手」のように特定ラベルの不在で定義するビューはexcludeLabelsの不一致で絞り込む。
      const navView = getNavView(view);
      const viewLabels = navView.labels;
      const excludeLabels = navView.excludeLabels;
      const hasNoLabelCondition =
        (!viewLabels || viewLabels.length === 0) && (!excludeLabels || excludeLabels.length === 0);
      if (hasNoLabelCondition) return issues;

      const matchesView = (issue: Issue) => {
        const issueLabelNames = issue.labels.map((label) => label.name);
        if (viewLabels && viewLabels.length > 0) {
          if (!issueLabelNames.some((name) => viewLabels.includes(name))) return false;
        }
        if (excludeLabels && excludeLabels.length > 0) {
          if (issueLabelNames.some((name) => excludeLabels.includes(name))) return false;
        }
        return true;
      };
      const matched = issues.filter(matchesView);
      if (!navView.latestReleaseOnly) return matched;
      return filterLatestReleaseIssues(matched, referenceIssues.filter(matchesView));
    }
  }
}

export function applyIssueFilters(
  issues: Issue[],
  filters: Pick<IssueFilters, "q" | "repos" | "state" | "labels" | "assignee">,
): Issue[] {
  const q = filters.q.trim();

  return issues.filter((issue) => {
    if (q && !matchesSearchQuery(issue, q)) return false;
    if (filters.repos.length > 0 && !filters.repos.includes(issue.repositoryFullName)) {
      return false;
    }
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

/**
 * 「ユーザーの確認待ち」ビュー（view=check-user）では、TopBarの並び順選択によらず
 * 確認待ちの起点となった日時の古い順に固定する。先に確認待ちになったIssueから順番に
 * 確認してもらうため。実際の未読コメント投稿日時（lastCommentAt）を優先し、
 * Webhook経由でまだ記録されていないIssueは00.check-userラベルが付与された日時
 * （checkUserLabeledAt）にフォールバックする。どちらも取れないIssueは最も古いものとして
 * 先頭に寄せる。
 */
export function sortIssues(issues: Issue[], sort: IssueSort, view?: NavViewId): Issue[] {
  if (view === "check-user") {
    return [...issues].sort(
      (a, b) => checkUserPendingSinceTime(a) - checkUserPendingSinceTime(b),
    );
  }

  const key: keyof Pick<Issue, "updatedAt" | "createdAt"> =
    sort === "created" ? "createdAt" : "updatedAt";
  return [...issues].sort(
    (a, b) => new Date(b[key]).getTime() - new Date(a[key]).getTime(),
  );
}

function checkUserPendingSinceTime(issue: Issue): number {
  const basis = issue.lastCommentAt ?? issue.checkUserLabeledAt;
  return basis ? new Date(basis).getTime() : -Infinity;
}

export type IssueRepositoryGroup = {
  repositoryFullName: string;
  repositoryPrivate: boolean;
  repositoryArchived: boolean;
  issues: Issue[];
};

/**
 * リポジトリごとにIssueをグループ化する（#849）。issuesの並び順（＝呼び出し側で
 * 確定済みのソート順）はグループ内でそのまま保ち、グループ自体はrepositoryFullNameの
 * 昇順（サイドバーの既定順と同じ）で並べる。
 */
export function groupIssuesByRepository(issues: Issue[]): IssueRepositoryGroup[] {
  const groups = new Map<string, IssueRepositoryGroup>();
  for (const issue of issues) {
    const existing = groups.get(issue.repositoryFullName);
    if (existing) {
      existing.issues.push(issue);
    } else {
      groups.set(issue.repositoryFullName, {
        repositoryFullName: issue.repositoryFullName,
        repositoryPrivate: issue.repositoryPrivate,
        repositoryArchived: issue.repositoryArchived,
        issues: [issue],
      });
    }
  }
  return [...groups.values()].sort((a, b) =>
    a.repositoryFullName.localeCompare(b.repositoryFullName),
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

/**
 * 概要カードの統計を求める。
 * 「確認待ち」はTopBarの絞り込みを適用した集合（issues）、「24時間以内の本番反映」
 * 「オープンIssue件数」はstate絞り込みを無視した集合（issuesIgnoringState）を基準にする
 * （close済みIssueが対象の指標や、TopBarのstate絞り込みに影響されたくない指標のため）。
 */
export function computeOverviewStats(
  issues: Issue[],
  issuesIgnoringState: Issue[],
): OverviewStat[] {
  const checkUserCount = issues.filter((issue) =>
    issue.labels.some((label) => label.name === CHECK_USER_LABEL),
  ).length;
  const recentlyReleasedCount = issuesIgnoringState.filter((issue) => {
    if (!issue.closedAt) return false;
    if (!issue.labels.some((label) => label.name === MAIN_MERGED_LABEL_NAME)) return false;
    return Date.now() - new Date(issue.closedAt).getTime() < DAY_MS;
  }).length;
  const openCount = issuesIgnoringState.filter((issue) => issue.state === "open").length;

  return [
    {
      label: "確認待ち",
      value: String(checkUserCount),
      diffLabel: "",
      linkedView: "check-user",
    },
    { label: "24時間以内の本番反映", value: `${recentlyReleasedCount}件`, diffLabel: "" },
    { label: "オープンIssue", value: String(openCount), diffLabel: "" },
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

/**
 * ポーリング前後のIssue配列を比較し、checkUserLabeledAtがnull→非nullに変わった
 * （＝00.check-userラベルが新たに付与された）Issueを抽出する。画面を開いている間の
 * トースト通知（#852）の発火判定に使う。
 * 直前の配列に存在しないIssue（新規作成・初回ポーリング等）はcheckUserLabeledAtが
 * nullだったとみなし、既に付与済みの状態で現れた場合も対象に含める。
 */
export function detectNewlyCheckUserIssues(prevIssues: Issue[], nextIssues: Issue[]): Issue[] {
  const prevById = new Map(prevIssues.map((issue) => [issue.id, issue] as const));
  return nextIssues.filter((issue) => {
    if (!issue.checkUserLabeledAt) return false;
    const prevIssue = prevById.get(issue.id);
    return !prevIssue?.checkUserLabeledAt;
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
    a.readCommentCount === b.readCommentCount &&
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
