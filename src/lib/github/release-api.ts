import { GithubApiError } from "@/lib/github/issues-api";

const GITHUB_API = "https://api.github.com";

/** 「develop→mainのリリースフロー」を自動化するworkflowのファイル名（release-develop-to-main.yml） */
export const RELEASE_WORKFLOW_FILE = "release-develop-to-main.yml";

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
}

/** リポジトリに`release-develop-to-main.yml`と同名のworkflowが存在するかどうか */
export async function fetchReleaseWorkflowExists(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${RELEASE_WORKFLOW_FILE}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return false;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return true;
}

/** 指定ブランチの`package.json`の`version`フィールドを取得する。ファイルが無ければnull */
export async function fetchPackageVersion(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: { content: string; encoding: string } = await res.json();
  const raw = Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf-8").toString("utf-8");
  const parsed: { version?: string } = JSON.parse(raw);
  return parsed.version ?? null;
}

export type GithubApiPullRequest = {
  number: number;
  html_url: string;
  title: string;
  head: { ref: string };
};

/** 指定ブランチをbaseとするopenなPull Requestの一覧を取得する */
export async function fetchOpenPullRequestsForBase(
  owner: string,
  repo: string,
  base: string,
  token: string,
): Promise<GithubApiPullRequest[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?base=${encodeURIComponent(base)}&state=open&per_page=30`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
}

/** 「Release develop to main」workflowをdevelopブランチを対象に手動起動する */
export async function dispatchReleaseWorkflow(
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${RELEASE_WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "develop" }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
}
