import type { Issue, IssueHierarchy } from "@/types/issue";

/**
 * 一覧の行へ出す親子関係のバッジ（#3469）。
 *
 * 親Issueは子の完了で終わるため、それ自体を「実装を開始」する必要は通常無い。一覧で親か子かが
 * 分からないと、実行不要な親まで実行してしまう。材料はGitHubのIssue payloadに載る
 * `sub_issues_summary`と`parent_issue_url`で、同期でDBへ保存した値をそのまま使う。
 */

/** `https://api.github.com/repos/<owner>/<repo>/issues/<番号>`から親を取り出す */
export function parseParentIssueUrl(
  url: string | null | undefined,
): { repositoryFullName: string; number: number } | null {
  if (!url) return null;
  const match = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
  if (!match) return null;
  return { repositoryFullName: match[1], number: Number(match[2]) };
}

/** 親子のどちらでもなければundefined（項目ごと省く） */
export function buildIssueHierarchy(
  total: number | null | undefined,
  completed: number | null | undefined,
  parentIssueUrl: string | null | undefined,
): IssueHierarchy | undefined {
  const children = total && total > 0 ? { total, completed: completed ?? 0 } : null;
  const parent = parseParentIssueUrl(parentIssueUrl);
  if (!children && !parent) return undefined;
  return { children, parent };
}

export type IssueHierarchyBadge = {
  kind: "parent" | "child";
  /** バッジの文言 */
  label: string;
  /** ホバーで出す補足 */
  title: string;
};

/** 行に並べるバッジ。親かつ子（中間のIssue）なら2つ返す */
export function resolveIssueHierarchyBadges(
  issue: Pick<Issue, "hierarchy" | "repositoryFullName">,
): IssueHierarchyBadge[] {
  const hierarchy = issue.hierarchy;
  if (!hierarchy) return [];
  const badges: IssueHierarchyBadge[] = [];
  if (hierarchy.children) {
    const { total, completed } = hierarchy.children;
    badges.push({
      kind: "parent",
      label: `親 ${completed}/${total}`,
      title: `親Issue（子${total}件のうち${completed}件完了）。子の完了で終わるため、通常は実装開始不要です`,
    });
  }
  if (hierarchy.parent) {
    const { repositoryFullName, number } = hierarchy.parent;
    const ref =
      repositoryFullName === issue.repositoryFullName
        ? `#${number}`
        : `${repositoryFullName.split("/").at(-1)}#${number}`;
    badges.push({
      kind: "child",
      label: `子 ↑${ref}`,
      title: `子Issue（親: ${repositoryFullName}#${number}）`,
    });
  }
  return badges;
}
