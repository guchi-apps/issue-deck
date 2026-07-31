import { fetchAllPages } from "@/lib/github/pagination";

const GITHUB_API = "https://api.github.com";

export type GithubApiIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: { login: string } | null;
  assignee: { login: string } | null;
  labels: ({ name: string; color: string } | string)[];
  milestone: { title: string; open_issues: number; closed_issues: number } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
};

export type GithubApiComment = {
  id: number;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
  reactions?: { "+1"?: number };
};

export async function fetchIssuesForRepo(
  owner: string,
  repo: string,
  token: string,
): Promise<GithubApiIssue[]> {
  const items = await fetchAllPages<GithubApiIssue>(
    `${GITHUB_API}/repos/${owner}/${repo}/issues?state=all&per_page=100&sort=updated&direction=desc`,
    token,
  );
  return items.filter((item) => !item.pull_request);
}

export async function fetchCommentsForIssue(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<GithubApiComment[]> {
  return fetchAllPages<GithubApiComment>(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
    token,
  );
}
