import { CI_GATE_CONTEXT, type CiGateDecision, type RequiredCheckDefinition, expandRequiredChecks } from "@/lib/backup-ci/state";
import { digestDefinition } from "@/lib/backup-ci/crypto";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * バックアップCI（#4065）と共通チェックの写し（#4113）が共用する、GitHubへの読み書き。
 * 共通チェック`issue-deck/ci-gate`の発行はここ（`publishCiGate`）だけが行う。
 */

/** 初期導入の対象はdevelop向けPRだけ（main向け・リリースは対象外） */
export const BACKUP_CI_BASE_REFS = ["develop"] as const;
export const DEFINITION_PATH = "ci/required-checks.json";

export function isBackupCiBaseRef(ref: string): boolean {
  return (BACKUP_CI_BASE_REFS as readonly string[]).includes(ref);
}

export class BackupCiError extends Error {
  constructor(
    readonly code:
      | "not_enabled"
      | "not_configured"
      | "not_found"
      | "not_eligible"
      | "definition_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "BackupCiError";
  }
}

export type PullRequestTarget = {
  state: string;
  headSha: string;
  headRef: string;
  headRepoFullName: string | null;
  baseSha: string;
  baseRef: string;
};

type GithubPullRequest = {
  number: number;
  state: string;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string };
};

function toTarget(pr: GithubPullRequest): PullRequestTarget {
  return {
    state: pr.state,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    headRepoFullName: pr.head.repo?.full_name ?? null,
    baseSha: pr.base.sha,
    baseRef: pr.base.ref,
  };
}

export async function fetchPullRequestTarget(
  repositoryFullName: string,
  prNumber: number,
  token: string,
): Promise<PullRequestTarget> {
  const url = `${GITHUB_API}/repos/${repositoryFullName}/pulls/${prNumber}`;
  const res = await githubFetch(url, token);
  if (!res.ok) throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url}`);
  return toTarget((await res.json()) as GithubPullRequest);
}

/** マージ判定（#4114）に要る、PRの状態とマージ可否 */
export type PullRequestMergeInfo = PullRequestTarget & {
  merged: boolean;
  draft: boolean;
  /** GitHubが計算中ならnull */
  mergeable: boolean | null;
  mergeableState: string | null;
};

export async function fetchPullRequestMergeInfo(
  repositoryFullName: string,
  prNumber: number,
  token: string,
): Promise<PullRequestMergeInfo> {
  const url = `${GITHUB_API}/repos/${repositoryFullName}/pulls/${prNumber}`;
  const res = await githubFetch(url, token);
  if (!res.ok) throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url}`);
  const pr = (await res.json()) as GithubPullRequest & {
    merged?: boolean;
    draft?: boolean;
    mergeable?: boolean | null;
    mergeable_state?: string | null;
  };
  return {
    ...toTarget(pr),
    merged: pr.merged === true,
    draft: pr.draft === true,
    mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
    mergeableState: typeof pr.mergeable_state === "string" ? pr.mergeable_state : null,
  };
}

/** PRの差分に、指定した接頭辞のパスが含まれるか（最大3000件。GitHubのAPIの上限） */
export async function pullRequestTouchesPath(
  repositoryFullName: string,
  prNumber: number,
  prefix: string,
  token: string,
): Promise<boolean> {
  for (let page = 1; page <= 30; page += 1) {
    const url = `${GITHUB_API}/repos/${repositoryFullName}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const res = await githubFetch(url, token);
    if (!res.ok) throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url}`);
    const files = (await res.json()) as { filename?: string; previous_filename?: string }[];
    if (files.some((f) => f.filename?.startsWith(prefix) || f.previous_filename?.startsWith(prefix))) return true;
    if (files.length < 100) return false;
  }
  return false;
}

/** baseが`baseRef`のopenなPR（最大100件）。共通チェックの写しの巡回に使う */
export async function listOpenPullRequestTargets(
  repositoryFullName: string,
  baseRef: string,
  token: string,
): Promise<(PullRequestTarget & { number: number })[]> {
  const url = `${GITHUB_API}/repos/${repositoryFullName}/pulls?state=open&base=${encodeURIComponent(baseRef)}&per_page=100`;
  const res = await githubFetch(url, token);
  if (!res.ok) throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url}`);
  const pulls = (await res.json()) as GithubPullRequest[];
  return pulls.map((pr) => ({ ...toTarget(pr), number: pr.number }));
}

/** PRのbaseにある検査定義。**PRのheadの定義は読まない**（PR内で検査を減らしても効かないように） */
export async function fetchDefinitionAt(
  repositoryFullName: string,
  sha: string,
  token: string,
): Promise<{ digest: string; checks: RequiredCheckDefinition[] }> {
  const url = `${GITHUB_API}/repos/${repositoryFullName}/contents/${DEFINITION_PATH}?ref=${sha}`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    throw new BackupCiError("definition_unavailable", `baseに検査定義（${DEFINITION_PATH}）がありません（HTTP ${res.status}）。`);
  }
  const json = (await res.json()) as { content?: string; encoding?: string };
  if (json.encoding !== "base64" || typeof json.content !== "string") {
    throw new BackupCiError("definition_unavailable", "検査定義を読み取れませんでした。");
  }
  const raw = Buffer.from(json.content, "base64");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    parsed = null;
  }
  const checks = expandRequiredChecks(parsed);
  if (!checks) throw new BackupCiError("definition_unavailable", "baseの検査定義の形式が不正です。");
  return { digest: digestDefinition(raw), checks };
}

/** 共通チェックを発行する。**失敗しても記録は進める**（権限不足は画面と記録の発行状況で分かる） */
export async function publishCiGate(
  repositoryFullName: string,
  sha: string,
  decision: CiGateDecision,
  targetUrl: string | null,
  token: string,
): Promise<string> {
  const url = `${GITHUB_API}/repos/${repositoryFullName}/statuses/${sha}`;
  try {
    const res = await githubFetch(url, token, {
      method: "POST",
      body: {
        state: decision.state,
        context: CI_GATE_CONTEXT,
        description: decision.description,
        ...(targetUrl ? { target_url: targetUrl } : {}),
      },
    });
    return res.ok ? decision.state : `publish_failed:${res.status}`;
  } catch (error) {
    console.error(`[ci-gate] 共通チェックの発行に失敗しました ${repositoryFullName}@${sha}:`, error);
    return "publish_failed:network";
  }
}

export async function installationTokenFor(repositoryFullName: string): Promise<string> {
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    include: { installation: true },
  });
  if (!repository) throw new BackupCiError("not_found", "リポジトリが見つかりません。");
  return getInstallationToken(repository.installation.installationId);
}
