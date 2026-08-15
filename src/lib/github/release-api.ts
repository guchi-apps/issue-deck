import { githubFetchJsonWithEtag } from "@/lib/github/conditional-request";
import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/** 「develop→mainのリリースフロー」を自動化するworkflowのファイル名（release-develop-to-main.yml） */
export const RELEASE_WORKFLOW_FILE = "release-develop-to-main.yml";

/** mainへのマージを受けて本番デプロイを行うworkflowのファイル名（deploy.yml） */
export const DEPLOY_WORKFLOW_FILE = "deploy.yml";

/** リポジトリに`release-develop-to-main.yml`と同名のworkflowが存在するかどうか */
export async function fetchReleaseWorkflowExists(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${RELEASE_WORKFLOW_FILE}`;
  const res = await githubFetch(url, token);
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
  const res = await githubFetch(url, token);
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
  body: string | null;
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
  const res = await githubFetch(url, token);
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
  const res = await githubFetch(url, token);
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

type CheckRun = { status: string; conclusion: string | null };

/** check-runsの1ページあたりの取得件数（GitHub APIの上限） */
const CHECK_RUNS_PAGE_SIZE = 100;

/**
 * check-runsを取得するページ数の上限。暴走防止のガードであり、通常のrefは1ページに収まる
 * （`develop`でも実測94件）。上限に当たった場合は取得できた範囲で判定する。
 */
const CHECK_RUNS_MAX_PAGES = 10;

/** チェックとして「通った」とみなすconclusion */
const PASSABLE_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * check-runsの集合からCI状態を決める。**未完了が1つでもあれば`pending`が最優先**で、
 * 失敗より先に判定する（実行中に落ちているものがあっても、まだ確定していないため）。
 */
export function resolveCiStateFromCheckRuns(runs: CheckRun[]): CiState {
  if (runs.length === 0) return "unknown";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  if (runs.some((r) => !r.conclusion || !PASSABLE_CONCLUSIONS.has(r.conclusion))) return "failure";
  return "success";
}

/**
 * check-runsの1ページ分を取得する。取得できなければ`null`（呼び出し側で`unknown`へ縮退させる）。
 *
 * PR一覧と同じくETagによる条件付きGETを通す（#1531）。CIが動いていないrefでは304が返り、
 * レート制限を消費しない。
 */
async function fetchCheckRunsPage(
  owner: string,
  repo: string,
  ref: string,
  token: string,
  page: number,
): Promise<{ totalCount: number; runs: CheckRun[] } | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=${CHECK_RUNS_PAGE_SIZE}&page=${page}`;
  const result = await githubFetchJsonWithEtag<{
    total_count?: number;
    check_runs?: CheckRun[];
  }>(url, token).catch(() => null);
  if (!result || !result.ok) return null;
  return { totalCount: result.data.total_count ?? 0, runs: result.data.check_runs ?? [] };
}

/**
 * 指定ref（ブランチ名/SHA）のGitHub Actionsチェック（check-runs）を集約したCI状態を返す。
 * `Checks: read`権限が無い等で取得に失敗した場合は例外を投げず`unknown`を返す（進捗表示は
 * あくまで補助情報のため、CI状態が取れなくてもマージ用URL自体は表示できるようにする）。
 *
 * **1ページ（100件）で打ち切らず、`total_count`を見て全ページを取得する。** refに紐づく
 * check-runsはCIワークフローだけでなく、その時点で走った全ワークフローのジョブを含むため
 * 容易に100件を超える（`develop`で実測94件）。打ち切ると、取得できなかった範囲の失敗を
 * 静かに取りこぼして`success`を返してしまう（#1061）。
 */
export async function fetchRefCiState(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<CiState> {
  const first = await fetchCheckRunsPage(owner, repo, ref, token, 1);
  if (!first) return "unknown";

  const runs = [...first.runs];
  const pageCount = Math.min(
    Math.ceil(first.totalCount / CHECK_RUNS_PAGE_SIZE),
    CHECK_RUNS_MAX_PAGES,
  );

  if (pageCount > 1) {
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, index) =>
        fetchCheckRunsPage(owner, repo, ref, token, index + 2),
      ),
    );
    // 1ページでも欠けると「失敗が無い」と誤判定しうるため、部分的な結果では判定しない。
    if (rest.some((page) => page === null)) return "unknown";
    for (const page of rest) {
      if (page) runs.push(...page.runs);
    }
  }

  return resolveCiStateFromCheckRuns(runs);
}

/**
 * マージ待ちPRのコンフリクト有無だけを取り出す（#1293）。
 *
 * `mergeable`はPRの単体取得でしか返らず、GitHub側で非同期に計算されるため判定前は`null`。
 * リリース進捗では「コンフリクトあり」の表示と自動解消ボタンの出し分けにしか使わないので、
 * `fetchRefCiState`が取得失敗を`unknown`へ縮退させるのと同じく、失敗しても例外にせず
 * `null`（＝判定できていない）として扱う。
 */
export async function fetchPullRequestMergeable(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<boolean | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`;
  const res = await githubFetch(url, token).catch(() => null);
  if (!res || !res.ok) return null;
  const data: { mergeable?: boolean | null } = await res.json().catch(() => ({}));
  return data.mergeable ?? null;
}

/** 「Release develop to main」workflowをdevelopブランチを対象に手動起動する */
export async function dispatchReleaseWorkflow(
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${RELEASE_WORKFLOW_FILE}/dispatches`;
  const res = await githubFetch(url, token, { method: "POST", body: { ref: "develop" } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
}
