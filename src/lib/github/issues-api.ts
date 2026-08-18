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

/**
 * コメント1件だけを取得する。`fetchCommentsForIssue`（全件・ページネーション付き）は
 * コメント単位の要約生成のように1件だけ必要な場面では無駄なAPI消費になるため分けている。
 */
export async function fetchComment(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<GithubApiComment> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
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

/**
 * Issueへラベルを**追加**する（#1217）。
 *
 * `updateIssue`の`labels`は**全置換**で、渡さなかったラベルが消える。既に付いている
 * `21.plan-required`・`11.local`などを巻き込んで落とすため、1つ足したいだけの用途には使えない。
 * GitHubの追加専用エンドポイントを使い、既に付いている場合も安全（重複しない）にする。
 *
 * **戻り値は追加後にIssueへ付いているラベル名。** GitHubがこのレスポンスで返してくれるので、
 * 「他に何が付いているか」を知るための追加のAPI呼び出しが要らない
 * （`src/lib/dispatch/check-user-labels.ts`が理由ラベルの付け替えに使う。#1490）。
 */
export async function addIssueLabels(
  owner: string,
  repo: string,
  number: number,
  token: string,
  labels: string[],
): Promise<string[]> {
  const after = (await requestJson(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/labels`,
    token,
    "POST",
    { labels },
  )) as { name?: unknown }[] | undefined;
  if (!Array.isArray(after)) return [];
  return after.map((label) => label.name).filter((name): name is string => typeof name === "string");
}

/**
 * リポジトリに**定義されている**ラベル名の集合を返す（#1490）。
 *
 * ラベルの付与エンドポイント（`addIssueLabels`）は、リポジトリに存在しないラベル名を渡すと
 * **その場でラベルを作ってしまう**（色も説明も無いまま増える）。無人実行のワークフローが
 * `gh label list --json name | grep -qx`で存在を確かめてから付けているのと同じガードを、
 * issue-deck本体の経路にも置くためのもの。
 */
export async function fetchRepositoryLabelNames(
  owner: string,
  repo: string,
  token: string,
): Promise<Set<string>> {
  const labels = await fetchAllPages<{ name: string }>(
    `${GITHUB_API}/repos/${owner}/${repo}/labels?per_page=100`,
    token,
  );
  return new Set(labels.map((label) => label.name));
}

/**
 * Issueに**いま付いている**ラベル名を返す（#1905）。
 *
 * 使うのは「外してよいか」を外す前に確かめたいときだけ（`src/lib/dispatch/check-user-labels.ts`）。
 * `addIssueLabels`・`removeIssueLabel`は操作後の一覧を返すので、付け外しのついでに知りたい
 * だけならそちらで足りる。**操作せずに読むための口はここにしか無い。**
 */
export async function fetchIssueLabelNames(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<string[]> {
  const labels = await fetchAllPages<{ name: string }>(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/labels?per_page=100`,
    token,
  );
  return labels.map((label) => label.name).filter((name) => typeof name === "string");
}

/**
 * Issueからラベルを**1つだけ**外す（#1342）。
 *
 * `addIssueLabels`と対になる。`updateIssue`の`labels`は全置換なので、外したい1つ以外を
 * すべて数え上げる必要があり、その間に他の経路が付けたラベルを落とす。
 *
 * **付いていないラベルを外そうとしたときの404は成功として扱う。** 呼び出し側（計画の承認待ちを
 * 解く経路）にとって「既に外れている」は望んだ結果そのもので、人が画面の承認ボタンで先に
 * 外した場合に必ず起きる。ラベル自体がリポジトリに存在しない場合も同じ404で返る。
 *
 * **戻り値は除去後にIssueへ残っているラベル名**（404のときはnull）。`addIssueLabels`と同じく
 * GitHubがレスポンスで返すため、続けて外すものを決めるための追加のAPI呼び出しが要らない。
 */
export async function removeIssueLabel(
  owner: string,
  repo: string,
  number: number,
  token: string,
  label: string,
): Promise<string[] | null> {
  try {
    const after = (await requestJson(
      `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
      token,
      "DELETE",
    )) as { name?: unknown }[] | undefined;
    if (!Array.isArray(after)) return [];
    return after
      .map((item) => item.name)
      .filter((name): name is string => typeof name === "string");
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) return null;
    throw error;
  }
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
 * GraphQLの`transferIssue`ミューテーション成功直後は、書き込み直後の読み取り一貫性の遅延により
 * REST APIでの再取得が一時的に404になることがあるため、短いバックオフを挟んで数回リトライする。
 */
const NEW_ISSUE_REFETCH_ATTEMPTS = 4;
const NEW_ISSUE_REFETCH_BASE_DELAY_MS = 300;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `transferIssue()`がGraphQLミューテーション成功後に投げるエラー。GitHub上では既に移動が
 * 完了しているため、呼び出し側は移動元Issueをissue-deckのDB上に残さないよう、最低限の
 * クリーンアップ（移動元リポジトリの再同期等）を行うべきことを示す。
 */
export class IssueTransferPartialError extends Error {
  constructor(
    public readonly newNumber: number,
    cause: unknown,
  ) {
    super(
      `GitHub上でのIssue移動は成功したが（新番号: ${newNumber}）、移動後の情報再取得に失敗した: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "IssueTransferPartialError";
    this.cause = cause;
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
  let lastError: GithubApiError | null = null;
  for (let attempt = 0; attempt < NEW_ISSUE_REFETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(NEW_ISSUE_REFETCH_BASE_DELAY_MS * attempt);
    }
    const newIssueRes = await githubFetch(
      `${GITHUB_API}/repos/${newOwner}/${newRepo}/issues/${newNumber}`,
      token,
    );
    if (newIssueRes.ok) {
      return newIssueRes.json();
    }
    const detail = await newIssueRes.text().catch(() => "");
    lastError = new GithubApiError(
      newIssueRes.status,
      `GitHub API request failed: ${newIssueRes.status} ${detail}`,
    );
  }
  throw new IssueTransferPartialError(newNumber, lastError);
}
