import { GithubApiError } from "@/lib/github/github-api-error";
import { fetchAllPages } from "@/lib/github/pagination";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

export { GithubApiError } from "@/lib/github/github-api-error";

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
  closed_at: string | null;
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
  const res = await githubFetch(url, token, { method, body });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
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

/**
 * IssueをGitHub上から完全に削除する。
 * REST APIにはIssue削除のエンドポイントが存在しないため、GraphQLの`deleteIssue`ミューテーションを使う。
 * このミューテーションはIssueのnode_id（GraphQL ID）を要求するが、REST APIのレスポンスにしか
 * 含まれないため、事前にREST APIでIssueを取得してnode_idを取得してから削除する。
 */
export async function deleteIssue(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<void> {
  const issueRes = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, token);
  if (!issueRes.ok) {
    const detail = await issueRes.text().catch(() => "");
    throw new GithubApiError(
      issueRes.status,
      `GitHub API request failed: ${issueRes.status} ${detail}`,
    );
  }
  const { node_id: nodeId }: { node_id: string } = await issueRes.json();

  const graphqlRes = await githubFetch(`${GITHUB_API}/graphql`, token, {
    method: "POST",
    body: {
      query: `mutation($issueId: ID!) { deleteIssue(input: { issueId: $issueId }) { clientMutationId } }`,
      variables: { issueId: nodeId },
    },
  });
  if (!graphqlRes.ok) {
    const detail = await graphqlRes.text().catch(() => "");
    throw new GithubApiError(
      graphqlRes.status,
      `GitHub GraphQL request failed: ${graphqlRes.status} ${detail}`,
    );
  }
  const graphqlData: { errors?: { message: string }[] } = await graphqlRes.json();
  if (graphqlData.errors?.length) {
    throw new GithubApiError(
      403,
      `GitHub GraphQL deleteIssue failed: ${graphqlData.errors.map((e) => e.message).join("; ")}`,
    );
  }
}

/**
 * IssueをGitHub上で別リポジトリへ移動する。
 * REST APIにはIssue移動のエンドポイントが存在しないため、GraphQLの`transferIssue`ミューテーションを使う。
 * このミューテーションは移動元Issue・移動先リポジトリ双方のnode_id（GraphQL ID）を要求するため、
 * 事前にREST APIで両方を取得してから移動する。移動後は新しいIssue番号でREST APIから
 * 完全なIssue情報を再取得して返す。
 */
export async function transferIssue(
  owner: string,
  repo: string,
  number: number,
  newOwner: string,
  newRepo: string,
  token: string,
): Promise<GithubApiIssue> {
  const issueRes = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, token);
  if (!issueRes.ok) {
    const detail = await issueRes.text().catch(() => "");
    throw new GithubApiError(
      issueRes.status,
      `GitHub API request failed: ${issueRes.status} ${detail}`,
    );
  }
  const { node_id: issueNodeId }: { node_id: string } = await issueRes.json();

  const destinationRepoRes = await githubFetch(`${GITHUB_API}/repos/${newOwner}/${newRepo}`, token);
  if (!destinationRepoRes.ok) {
    const detail = await destinationRepoRes.text().catch(() => "");
    throw new GithubApiError(
      destinationRepoRes.status,
      `GitHub API request failed: ${destinationRepoRes.status} ${detail}`,
    );
  }
  const { node_id: destinationRepoNodeId }: { node_id: string } = await destinationRepoRes.json();

  const graphqlRes = await githubFetch(`${GITHUB_API}/graphql`, token, {
    method: "POST",
    body: {
      query: `mutation($issueId: ID!, $repositoryId: ID!) {
        transferIssue(input: { issueId: $issueId, repositoryId: $repositoryId }) {
          issue { number }
        }
      }`,
      variables: { issueId: issueNodeId, repositoryId: destinationRepoNodeId },
    },
  });
  if (!graphqlRes.ok) {
    const detail = await graphqlRes.text().catch(() => "");
    throw new GithubApiError(
      graphqlRes.status,
      `GitHub GraphQL request failed: ${graphqlRes.status} ${detail}`,
    );
  }
  const graphqlData: {
    data?: { transferIssue: { issue: { number: number } } };
    errors?: { message: string }[];
  } = await graphqlRes.json();
  if (graphqlData.errors?.length || !graphqlData.data) {
    const message = graphqlData.errors?.map((e) => e.message).join("; ") ?? "unknown error";
    const hint = message.includes("Resource not accessible by integration")
      ? " (IssueDeckのGitHub AppにAdministration権限が不足している可能性があります)"
      : "";
    throw new GithubApiError(403, `GitHub GraphQL transferIssue failed: ${message}${hint}`);
  }

  const newNumber = graphqlData.data.transferIssue.issue.number;
  const newIssueRes = await githubFetch(
    `${GITHUB_API}/repos/${newOwner}/${newRepo}/issues/${newNumber}`,
    token,
  );
  if (!newIssueRes.ok) {
    const detail = await newIssueRes.text().catch(() => "");
    throw new GithubApiError(
      newIssueRes.status,
      `GitHub API request failed: ${newIssueRes.status} ${detail}`,
    );
  }
  return newIssueRes.json();
}
