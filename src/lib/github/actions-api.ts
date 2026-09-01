import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

export type GithubApiWorkflowRun = {
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  run_started_at: string;
  updated_at: string;
};

export async function fetchWorkflowRun(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<GithubApiWorkflowRun> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
}

export type GithubApiWorkflowJobStep = {
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
};

export type GithubApiWorkflowJob = {
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  steps: GithubApiWorkflowJobStep[];
};

export async function fetchWorkflowRunJobs(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<GithubApiWorkflowJob[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: { jobs: GithubApiWorkflowJob[] } = await res.json();
  return data.jobs;
}

export async function cancelWorkflowRun(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/cancel`;
  const res = await githubFetch(url, token, { method: "POST" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
}

export async function forceCancelWorkflowRun(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/force-cancel`;
  const res = await githubFetch(url, token, { method: "POST" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
}

export type GithubApiPullRequest = {
  head: { sha: string };
};

export async function fetchPullRequest(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<GithubApiPullRequest> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
}

/**
 * マージの結果。**`sha`（マージコミットのSHA）を捨てない**（#2703）。
 *
 * mainへのマージでは、この値が「GitHubが本当にこのマージのイベントを配送したか」を
 * 後から照合するための唯一の鍵になる（`deploy.yml`の実行の`head_sha`と突き合わせる）。
 * 取れなかったときはnull——照合できないだけで、マージ自体は成功している。
 */
export type MergePullRequestResult = {
  /** マージコミットのSHA。レスポンスから読めなければnull */
  sha: string | null;
};

export async function mergePullRequest(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<MergePullRequestResult> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/merge`;
  const res = await githubFetch(url, token, { method: "PUT", body: { merge_method: "merge" } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: { sha?: unknown } = await res.json().catch(() => ({}));
  return { sha: typeof data.sha === "string" ? data.sha : null };
}

