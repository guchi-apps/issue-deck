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

export type GithubApiRepoLabel = { name: string; color: string };

export async function fetchRepoLabels(
  owner: string,
  repo: string,
  token: string,
): Promise<GithubApiRepoLabel[]> {
  return fetchAllPages<GithubApiRepoLabel>(
    `${GITHUB_API}/repos/${owner}/${repo}/labels?per_page=100`,
    token,
  );
}

export async function fetchRepoAssignees(
  owner: string,
  repo: string,
  token: string,
): Promise<{ login: string }[]> {
  return fetchAllPages<{ login: string }>(
    `${GITHUB_API}/repos/${owner}/${repo}/assignees?per_page=100`,
    token,
  );
}

async function requestJson(url: string, token: string, method: "POST" | "PATCH", body: unknown) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
}

export type CreateIssueInput = {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
};

export async function createIssue(
  owner: string,
  repo: string,
  token: string,
  input: CreateIssueInput,
): Promise<GithubApiIssue> {
  return requestJson(`${GITHUB_API}/repos/${owner}/${repo}/issues`, token, "POST", input);
}

export type UpdateIssueInput = {
  title?: string;
  body?: string;
  state?: "open" | "closed";
};

export async function updateIssue(
  owner: string,
  repo: string,
  number: number,
  token: string,
  input: UpdateIssueInput,
): Promise<GithubApiIssue> {
  return requestJson(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`,
    token,
    "PATCH",
    input,
  );
}
