import {
  resolveDeployRecoverySelection,
  selectDeployRecoveryCandidates,
  type DeployRecoveryCandidate,
} from "@/lib/deploy-recovery";
import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

type GithubClosedPullRequest = {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { ref: string };
};

type GithubOpenPullRequest = { html_url: string; head: { ref: string }; body: string | null };

export class DeployRecoveryConflictError extends Error {
  constructor() {
    super("選択したPRの取り込みで競合しました");
    this.name = "DeployRecoveryConflictError";
  }
}

function throwGithubError(status: number, url: string, detail: string): never {
  throw new GithubApiError(status, `GitHub API request failed: ${status} ${url} ${detail}`);
}

async function requestJson<T>(url: string, token: string): Promise<T> {
  const response = await githubFetch(url, token);
  if (!response.ok) throwGithubError(response.status, url, await response.text().catch(() => ""));
  return response.json();
}

/** developにはありmainにはないマージ済みPRを取得する。 */
export async function fetchDeployRecoveryCandidates(
  owner: string,
  repo: string,
  token: string,
): Promise<DeployRecoveryCandidate[]> {
  const prefix = `${GITHUB_API}/repos/${owner}/${repo}`;
  const [comparison, pullRequests] = await Promise.all([
    requestJson<{ commits?: Array<{ sha?: string }> }>(`${prefix}/compare/main...develop?per_page=100`, token),
    requestJson<GithubClosedPullRequest[]>(
      `${prefix}/pulls?state=closed&base=develop&sort=updated&direction=desc&per_page=100`,
      token,
    ),
  ]);
  const commits = new Set((comparison.commits ?? []).flatMap((commit) => (commit.sha ? [commit.sha] : [])));
  const merged = pullRequests.flatMap((pullRequest) => {
    if (!pullRequest.merged_at || !pullRequest.merge_commit_sha || pullRequest.base.ref !== "develop") return [];
    return [{
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.html_url,
      mergedAt: pullRequest.merged_at,
      mergeCommitSha: pullRequest.merge_commit_sha,
    }];
  });
  return selectDeployRecoveryCandidates(merged, commits);
}

function recoveryBranch(selected: DeployRecoveryCandidate[]): string {
  const selection = selected.map((candidate) => candidate.number).join("-");
  // GitHubのブランチ名の上限に候補数が依存しないよう、選択内容は短い安定ハッシュへ畳む。
  let hash = 5381;
  for (const character of selection) hash = (hash * 33) ^ character.charCodeAt(0);
  return `deploy-recovery/${selected[0].number}-${selected.at(-1)?.number}-${(hash >>> 0).toString(36)}`;
}

function marker(selected: DeployRecoveryCandidate[]): string {
  return `<!-- issue-deck-deploy-recovery:${selected.map((candidate) => candidate.number).join(",")} -->`;
}

/** 選択したPRだけをmain起点のブランチへ取り込み、main向けPRを作成する。 */
export async function createDeployRecoveryPullRequest(
  owner: string,
  repo: string,
  token: string,
  selectedNumbers: number[],
): Promise<{ url: string }> {
  const candidates = await fetchDeployRecoveryCandidates(owner, repo, token);
  const selected = resolveDeployRecoverySelection(candidates, selectedNumbers);
  if (!selected) throw new RangeError("candidate_changed");

  const prefix = `${GITHUB_API}/repos/${owner}/${repo}`;
  const selectedMarker = marker(selected);
  const openPullRequests = await requestJson<GithubOpenPullRequest[]>(
    `${prefix}/pulls?state=open&base=main&per_page=100`,
    token,
  );
  const existing = openPullRequests.find((pullRequest) => pullRequest.body?.includes(selectedMarker));
  if (existing) return { url: existing.html_url };

  const branch = recoveryBranch(selected);
  const main = await requestJson<{ object?: { sha?: string } }>(`${prefix}/git/ref/heads/main`, token);
  const mainSha = main.object?.sha;
  if (!mainSha) throw new GithubApiError(502, "GitHub API response did not include main SHA");

  const createRefUrl = `${prefix}/git/refs`;
  const createRef = await githubFetch(createRefUrl, token, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: mainSha },
  });
  if (!createRef.ok) {
    throwGithubError(createRef.status, createRefUrl, await createRef.text().catch(() => ""));
  }

  let pullRequestCreated = false;
  try {
    for (const candidate of selected) {
      const mergeUrl = `${prefix}/merges`;
      const merge = await githubFetch(mergeUrl, token, {
        method: "POST",
        body: { base: branch, head: candidate.mergeCommitSha, commit_message: `本番復旧: #${candidate.number}` },
      });
      if (merge.status === 409) throw new DeployRecoveryConflictError();
      if (!merge.ok) throwGithubError(merge.status, mergeUrl, await merge.text().catch(() => ""));
    }

    const pullUrl = `${prefix}/pulls`;
    const body = [
      "## 本番デプロイの復旧",
      "",
      "失敗した本番デプロイを復旧するため、選択したdevelop向けPRだけをmainへ取り込みます。",
      "未選択のdevelop変更は含めません。mainへマージするとdeploy.ymlが起動します。",
      "",
      "## 取り込むPR",
      ...selected.map((candidate) => `- #${candidate.number} ${candidate.title}`),
      "",
      selectedMarker,
    ].join("\n");
    const pull = await githubFetch(pullUrl, token, {
      method: "POST",
      body: {
        title: `本番デプロイを復旧する（${selected.map((candidate) => `#${candidate.number}`).join(", ")}）`,
        head: branch,
        base: "main",
        body,
      },
    });
    if (!pull.ok) throwGithubError(pull.status, pullUrl, await pull.text().catch(() => ""));
    pullRequestCreated = true;
    const data: { html_url?: string } = await pull.json();
    if (!data.html_url) throw new GithubApiError(502, "GitHub API response did not include pull request URL");
    return { url: data.html_url };
  } catch (error) {
    // PRを作る前の失敗では、途中ブランチを残さず押し直し時の重複を防ぐ。
    if (!pullRequestCreated) {
      const deleteRefUrl = `${prefix}/git/refs/heads/${branch}`;
      await githubFetch(deleteRefUrl, token, { method: "DELETE" }).catch(() => undefined);
    }
    throw error;
  }
}
