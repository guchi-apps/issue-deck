import { GithubApiError } from "@/lib/github/github-api-error";

const GITHUB_API = "https://api.github.com";

/** 「develop→mainのリリースフロー」を自動化するworkflowのファイル名（release-develop-to-main.yml） */
export const RELEASE_WORKFLOW_FILE = "release-develop-to-main.yml";

/** mainへのマージを受けて本番デプロイを行うworkflowのファイル名（deploy.yml） */
export const DEPLOY_WORKFLOW_FILE = "deploy.yml";

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

export type ReleaseWorkflowRun = {
  /** queued | in_progress | completed など */
  status: string;
  /** success | failure | cancelled | null（未完了時） */
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
};

async function fetchLatestWorkflowRun(
  owner: string,
  repo: string,
  workflowFile: string,
  token: string,
  query?: string,
): Promise<ReleaseWorkflowRun | null> {
  const qs = query ? `&${query}` : "";
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=1${qs}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: {
    workflow_runs?: Array<{ status: string; conclusion: string | null; html_url: string; created_at: string }>;
  } = await res.json();
  const run = data.workflow_runs?.[0];
  if (!run) return null;
  return {
    status: run.status,
    conclusion: run.conclusion ?? null,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
  };
}

/** `release-develop-to-main.yml`の最新の実行（run）を1件取得する。無ければnull */
export async function fetchLatestReleaseWorkflowRun(
  owner: string,
  repo: string,
  token: string,
): Promise<ReleaseWorkflowRun | null> {
  return fetchLatestWorkflowRun(owner, repo, RELEASE_WORKFLOW_FILE, token);
}

/**
 * mainブランチ上の`deploy.yml`（本番デプロイ）の最新の実行（run）を1件取得する。無ければnull。
 * mainへのマージ後にこのrunを追うことで、デプロイまで成功したかを見届けられるようにする(#392)。
 */
export async function fetchLatestDeployWorkflowRun(
  owner: string,
  repo: string,
  token: string,
): Promise<ReleaseWorkflowRun | null> {
  return fetchLatestWorkflowRun(owner, repo, DEPLOY_WORKFLOW_FILE, token, "branch=main");
}

/** CIの集約状態。`unknown`は権限不足やチェック未検出で判定できないことを表す */
export type CiState = "pending" | "success" | "failure" | "unknown";

/**
 * 指定ref（ブランチ名/SHA）のGitHub Actionsチェック（check-runs）を集約したCI状態を返す。
 * `Checks: read`権限が無い等で取得に失敗した場合は例外を投げず`unknown`を返す（進捗表示は
 * あくまで補助情報のため、CI状態が取れなくてもマージ用URL自体は表示できるようにする）。
 */
export async function fetchRefCiState(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<CiState> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`;
  const res = await fetch(url, { headers: authHeaders(token) }).catch(() => null);
  if (!res || !res.ok) return "unknown";
  const data: { check_runs?: Array<{ status: string; conclusion: string | null }> } = await res
    .json()
    .catch(() => ({}));
  const runs = data.check_runs ?? [];
  if (runs.length === 0) return "unknown";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  const passable = new Set(["success", "neutral", "skipped"]);
  if (runs.some((r) => !r.conclusion || !passable.has(r.conclusion))) return "failure";
  return "success";
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
