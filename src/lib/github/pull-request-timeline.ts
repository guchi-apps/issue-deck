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
 * timelineイベント一覧からcross-reference（同一リポジトリのPRからの`#番号`参照）をすべて抽出する。
 * 同じPRが複数回参照されることがあるため番号でdedupeし、番号の昇順で返す（#1339）。
 */
export function extractCrossReferencedPullRequestLinks(
  events: GithubApiTimelineEvent[],
  owner: string,
  repo: string,
): PullRequestLink[] {
  const byNumber = new Map<number, PullRequestLink>();

  for (const event of events) {
    const issue = event.source?.issue;
    if (event.event !== "cross-referenced" || !issue?.pull_request) continue;
    if (issue.repository && issue.repository.full_name !== `${owner}/${repo}`) continue;
    if (byNumber.has(issue.number)) continue;
    byNumber.set(issue.number, { url: issue.html_url, number: issue.number });
  }

  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * コメントURLパース（`extractPullRequestLinks`）で1件も見つからなかった場合のフォールバック。
 * PR本文中の`#番号`参照はGitHubがcross-reference（timelineイベント）として自動記録するため、
 * 報告コメントの投稿有無やPRのブランチ命名規約に依存せず対応PRを検出できる。
 */
export async function fetchCrossReferencedPullRequestLinks(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<PullRequestLink[]> {
  const events = await fetchAllPages<GithubApiTimelineEvent>(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`,
    token,
  );
  return extractCrossReferencedPullRequestLinks(events, owner, repo);
}
