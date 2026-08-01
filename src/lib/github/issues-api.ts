import { fetchAllPages } from "@/lib/github/pagination";

const GITHUB_API = "https://api.github.com";

export type GithubApiIssueStateReason = "completed" | "not_planned" | "reopened" | null;

export type GithubApiIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason?: GithubApiIssueStateReason;
  html_url: string;
  user: { login: string } | null;
  assignee: { login: string } | null;
  labels: ({ id: number; name: string; color: string; description: string | null } | string)[];
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

export type GithubApiRepoLabel = { name: string; color: string; description: string | null };

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

async function requestJson(
  url: string,
  token: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  if (res.status === 204) return undefined;
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
  state_reason?: "completed" | "not_planned";
  labels?: string[];
  assignees?: string[];
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

export type CommentBodyInput = {
  body: string;
};

export async function createComment(
  owner: string,
  repo: string,
  number: number,
  token: string,
  input: CommentBodyInput,
): Promise<GithubApiComment> {
  return requestJson(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/comments`,
    token,
    "POST",
    input,
  );
}

export async function updateComment(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
  input: CommentBodyInput,
): Promise<GithubApiComment> {
  return requestJson(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    token,
    "PATCH",
    input,
  );
}

export async function deleteComment(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<void> {
  await requestJson(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    token,
    "DELETE",
  );
}
