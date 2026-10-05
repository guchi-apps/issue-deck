import {
  resolveDeployRecoverySelection,
  selectDeployRecoveryCandidates,
  type DeployRecoveryCandidate,
  type DeployRecoveryCandidatesResult,
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
  /** 取り込めなかったPR番号と理由。画面へ「理由と候補」として返す。 */
  readonly detail: string;

  constructor(detail = "") {
    super(detail ? `選択したPRの取り込みで競合しました: ${detail}` : "選択したPRの取り込みで競合しました");
    this.name = "DeployRecoveryConflictError";
    this.detail = detail;
  }
}

/** 復旧PRの最終差分が「選択した修正＋版上げ」に収まらないときに投げる。 */
export class DeployRecoveryVerificationError extends Error {
  constructor(detail: string) {
    super(`復旧ブランチの最終差分を検証できませんでした: ${detail}`);
    this.name = "DeployRecoveryVerificationError";
  }
}

type GithubCommit = {
  sha: string;
  parents?: Array<{ sha: string }>;
  tree?: { sha: string };
  files?: Array<{ filename: string; status: string; sha?: string; previous_filename?: string }>;
};
type GithubTree = { truncated?: boolean; tree: Array<{ path: string; mode: string; type: string; sha: string }> };
type TreeEntry = { path: string; mode: string; type: string; sha: string };

/** 1コミットのfilesはAPIが300件で打ち切るため、それ以上は差分を信用しない。 */
const COMMIT_FILES_LIMIT = 300;
const DEPENDENCY_FILES = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/;

export function isDependencyFile(path: string): boolean {
  return DEPENDENCY_FILES.test(path);
}

/** package.jsonの`version`を、使われていない次のパッチ版へ上げる。 */
export function nextPatchVersion(current: string, taken: ReadonlySet<string>): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new DeployRecoveryVerificationError(`版を解釈できません: ${current}`);
  let patch = Number(match[3]);
  for (;;) {
    patch += 1;
    const candidate = `${match[1]}.${match[2]}.${patch}`;
    if (!taken.has(candidate)) return candidate;
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
): Promise<DeployRecoveryCandidatesResult> {
  const prefix = `${GITHUB_API}/repos/${owner}/${repo}`;
  const [comparison, pullRequestsResponse] = await Promise.all([
    requestJson<{ commits?: Array<{ sha?: string }>; total_commits?: number }>(`${prefix}/compare/main...develop?per_page=100`, token),
    githubFetch(`${prefix}/pulls?state=closed&base=develop&sort=updated&direction=desc&per_page=100`, token),
  ]);
  if (!pullRequestsResponse.ok) {
    throwGithubError(pullRequestsResponse.status, `${prefix}/pulls`, await pullRequestsResponse.text().catch(() => ""));
  }
  const pullRequests = await pullRequestsResponse.json() as GithubClosedPullRequest[];
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
  return {
    candidates: selectDeployRecoveryCandidates(merged, commits),
    truncated:
      (comparison.total_commits ?? comparison.commits?.length ?? 0) > (comparison.commits?.length ?? 0) ||
      pullRequestsResponse.headers?.get("link")?.includes('rel="next"') === true,
  };
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


async function treeOf(prefix: string, token: string, commitSha: string): Promise<Map<string, TreeEntry>> {
  const commit = await requestJson<GithubCommit>(`${prefix}/git/commits/${commitSha}`, token);
  const treeSha = commit.tree?.sha;
  if (!treeSha) throw new GithubApiError(502, "GitHub API response did not include tree SHA");
  const tree = await requestJson<GithubTree>(`${prefix}/git/trees/${treeSha}?recursive=1`, token);
  // 木が打ち切られると「このファイルは変わっていない」の判定が成り立たない。
  if (tree.truncated) throw new DeployRecoveryVerificationError("ファイル一覧が大きすぎて取得を打ち切られました");
  return new Map(tree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry]));
}

/**
 * 選択したPRの「マージ差分」（第1親→マージコミット）だけを、main起点のブランチへ順に適用する。
 * merges APIはマージコミットの祖先ごと取り込み、未選択のdevelop変更が混ざるため使わない。
 * 各ファイルは、ブランチ上のblobが差分の起点（第1親）のblobと一致するときだけ置き換える。
 * 食い違うものは他の未選択PRの変更に依存しているので、範囲を広げず競合として止める。
 */
async function applySelectedChanges(
  prefix: string,
  token: string,
  branch: string,
  mainSha: string,
  selected: DeployRecoveryCandidate[],
): Promise<{ version: string }> {
  let headSha = mainSha;
  let headFiles = await treeOf(prefix, token, headSha);
  const mainFiles = headFiles;
  const touched = new Set<string>();

  for (const candidate of selected) {
    const commit = await requestJson<GithubCommit>(`${prefix}/commits/${candidate.mergeCommitSha}`, token);
    const parentSha = commit.parents?.[0]?.sha;
    if (!parentSha) throw new DeployRecoveryConflictError(`#${candidate.number}: マージコミットの第1親を取得できません`);
    const files = commit.files ?? [];
    if (files.length >= COMMIT_FILES_LIMIT) {
      throw new DeployRecoveryConflictError(`#${candidate.number}: 変更ファイルが多すぎて差分を安全に切り出せません`);
    }
    const baseFiles = await treeOf(prefix, token, parentSha);
    const mergedFiles = await treeOf(prefix, token, candidate.mergeCommitSha);

    const entries: Array<{ path: string; mode?: string; type?: string; sha: string | null }> = [];
    const blocked: string[] = [];
    for (const file of files) {
      const paths = file.status === "renamed" && file.previous_filename ? [file.previous_filename, file.filename] : [file.filename];
      for (const path of paths) {
        if ((headFiles.get(path)?.sha ?? null) !== (baseFiles.get(path)?.sha ?? null)) blocked.push(path);
      }
      if (file.status === "removed") entries.push({ path: file.filename, sha: null });
      else {
        const mode = mergedFiles.get(file.filename)?.mode ?? "100644";
        if (!file.sha) throw new DeployRecoveryConflictError(`#${candidate.number}: ${file.filename}の内容を取得できません`);
        entries.push({ path: file.filename, mode, type: "blob", sha: file.sha });
        if (file.status === "renamed" && file.previous_filename) entries.push({ path: file.previous_filename, sha: null });
      }
    }
    if (blocked.length > 0) {
      const dependency = blocked.filter(isDependencyFile);
      throw new DeployRecoveryConflictError(
        `#${candidate.number}は未選択のdevelop変更と同じファイルを変更しています: ${blocked.slice(0, 5).join(", ")}` +
          (dependency.length > 0
            ? `。依存関係ファイル（${dependency.join(", ")}）を安全に分離できないため範囲を広げずに止めます。依存を変えた未選択PRを候補に加えるか、修正だけを別の変更として出し直してください`
            : ""),
      );
    }
    headSha = await commitTree(prefix, token, headSha, entries, `本番復旧: #${candidate.number}`);
    headFiles = await treeOf(prefix, token, headSha);
    for (const entry of entries) touched.add(entry.path);
  }

  // 新しいパッチ版を採番する（既存タグがある番号は飛ばし、タグは動かさない）。
  const packageEntry = headFiles.get("package.json");
  if (!packageEntry) throw new DeployRecoveryVerificationError("package.jsonがありません");
  const blob = await requestJson<{ content: string; encoding: string }>(`${prefix}/git/blobs/${packageEntry.sha}`, token);
  const text = Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  const current = /"version"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  if (!current) throw new DeployRecoveryVerificationError("package.jsonにversionがありません");
  const taken = await existingTagVersions(prefix, token);
  const version = nextPatchVersion(current, taken);
  const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  const newBlob = await githubFetch(`${prefix}/git/blobs`, token, {
    method: "POST",
    body: { content: updated, encoding: "utf-8" },
  });
  if (!newBlob.ok) throwGithubError(newBlob.status, `${prefix}/git/blobs`, await newBlob.text().catch(() => ""));
  const newBlobSha: { sha?: string } = await newBlob.json();
  if (!newBlobSha.sha) throw new GithubApiError(502, "GitHub API response did not include blob SHA");
  headSha = await commitTree(
    prefix,
    token,
    headSha,
    [{ path: "package.json", mode: packageEntry.mode, type: "blob", sha: newBlobSha.sha }],
    `本番復旧: 版を${version}へ上げる`,
  );
  touched.add("package.json");

  // 最終差分の機械検証: mainとの差が「選択した修正で触れたファイル＋package.json」だけであること。
  const finalFiles = await treeOf(prefix, token, headSha);
  const changed = new Set<string>();
  for (const path of new Set([...mainFiles.keys(), ...finalFiles.keys()])) {
    if (mainFiles.get(path)?.sha !== finalFiles.get(path)?.sha) changed.add(path);
  }
  const unexpected = [...changed].filter((path) => !touched.has(path));
  if (unexpected.length > 0) throw new DeployRecoveryVerificationError(`想定外の変更: ${unexpected.slice(0, 5).join(", ")}`);

  const updateRefUrl = `${prefix}/git/refs/heads/${branch}`;
  const update = await githubFetch(updateRefUrl, token, { method: "PATCH", body: { sha: headSha, force: false } });
  if (!update.ok) throwGithubError(update.status, updateRefUrl, await update.text().catch(() => ""));
  return { version };
}

async function existingTagVersions(prefix: string, token: string): Promise<Set<string>> {
  const tags = await requestJson<Array<{ name: string }>>(`${prefix}/tags?per_page=100`, token);
  return new Set(tags.map((tag) => tag.name.replace(/^v/, "")));
}

async function commitTree(
  prefix: string,
  token: string,
  parentSha: string,
  entries: Array<{ path: string; mode?: string; type?: string; sha: string | null }>,
  message: string,
): Promise<string> {
  const parent = await requestJson<GithubCommit>(`${prefix}/git/commits/${parentSha}`, token);
  const treeUrl = `${prefix}/git/trees`;
  const tree = await githubFetch(treeUrl, token, { method: "POST", body: { base_tree: parent.tree?.sha, tree: entries } });
  if (!tree.ok) throwGithubError(tree.status, treeUrl, await tree.text().catch(() => ""));
  const treeData: { sha?: string } = await tree.json();
  const commitUrl = `${prefix}/git/commits`;
  const commit = await githubFetch(commitUrl, token, {
    method: "POST",
    body: { message, tree: treeData.sha, parents: [parentSha] },
  });
  if (!commit.ok) throwGithubError(commit.status, commitUrl, await commit.text().catch(() => ""));
  const commitData: { sha?: string } = await commit.json();
  if (!commitData.sha) throw new GithubApiError(502, "GitHub API response did not include commit SHA");
  return commitData.sha;
}

/** 選択したPRだけをmain起点のブランチへ取り込み、main向けPRを作成する。 */
export async function createDeployRecoveryPullRequest(
  owner: string,
  repo: string,
  token: string,
  selectedNumbers: number[],
): Promise<{ url: string }> {
  const { candidates } = await fetchDeployRecoveryCandidates(owner, repo, token);
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
    const { version } = await applySelectedChanges(prefix, token, branch, mainSha, selected);

    const pullUrl = `${prefix}/pulls`;
    const body = [
      "## 本番デプロイの復旧",
      "",
      "失敗した本番デプロイを復旧するため、選択したdevelop向けPRだけをmainへ取り込みます。",
      "未選択のdevelop変更は含めません（各PRのマージ差分だけを適用し、祖先コミットは持ち込みません）。",
      "mainへマージするとdeploy.ymlが起動します。",
      "",
      `## 新しい版\n\n\`package.json\`のversionを${version}へ上げます。既存タグは移動しません。`,
      "",
      "## マージ後に必要な作業",
      `developの\`package.json\`のversionがmainと食い違うため、このPRのマージ後、通常リリース（release-develop-to-main）の前にdevelopのversionを${version}以上へ揃えるPRを入れてください。揃えないと、状態判定が「バンプ済み」と見てversionを巻き戻したままリリースPRを作ります。`,
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
