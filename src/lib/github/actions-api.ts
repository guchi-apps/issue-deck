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

export async function mergePullRequest(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/merge`;
  const res = await githubFetch(url, token, { method: "PUT", body: { merge_method: "merge" } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
}

export type GithubApiCheckRun = {
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
};

export async function fetchCheckRuns(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<GithubApiCheckRun[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/commits/${ref}/check-runs`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: { check_runs: GithubApiCheckRun[] } = await res.json();
  return data.check_runs;
}
