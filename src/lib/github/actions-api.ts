import { GithubApiError } from "@/lib/github/github-api-error";

const GITHUB_API = "https://api.github.com";

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
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
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
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: { jobs: GithubApiWorkflowJob[] } = await res.json();
  return data.jobs;
}
