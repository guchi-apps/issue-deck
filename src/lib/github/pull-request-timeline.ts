import { fetchAllPages } from "@/lib/github/pagination";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import { GITHUB_API } from "@/lib/github/request";

type GithubApiTimelineCrossReferenceIssue = {
  number: number;
  html_url: string;
  pull_request?: unknown;
  repository?: { full_name: string };
};

export type GithubApiTimelineEvent = {
  event: string;
  source?: {
    type?: string;
    issue?: GithubApiTimelineCrossReferenceIssue;
  };
};

/**
 * timelineイベント一覧のうち最新のcross-reference（同一リポジトリのPRからの`#番号`参照）を抽出する。
 * 該当が無ければnull。
 */
export function extractCrossReferencedPullRequestLink(
  events: GithubApiTimelineEvent[],
  owner: string,
  repo: string,
): PullRequestLink | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const issue = events[i].source?.issue;
    if (events[i].event !== "cross-referenced" || !issue?.pull_request) continue;
    if (issue.repository && issue.repository.full_name !== `${owner}/${repo}`) continue;
    return { url: issue.html_url, number: issue.number };
  }
  return null;
}

/**
 * コメントURLパース（`extractLatestPullRequestLink`）で見つからなかった場合のフォールバック。
 * PR本文中の`#番号`参照はGitHubがcross-reference（timelineイベント）として自動記録するため、
 * 報告コメントの投稿有無やPRのブランチ命名規約に依存せず対応PRを検出できる。
 */
export async function fetchCrossReferencedPullRequestLink(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<PullRequestLink | null> {
  const events = await fetchAllPages<GithubApiTimelineEvent>(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`,
    token,
  );
  return extractCrossReferencedPullRequestLink(events, owner, repo);
}
