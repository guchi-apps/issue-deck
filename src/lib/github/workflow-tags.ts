import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  evaluateWorkflowTags,
  extractWorkflowTagRef,
  latestWorkflowTag,
  type WorkflowTagRef,
  type WorkflowTagStatus,
} from "@/lib/workflow-tags";

/**
 * 各リポジトリが参照している共有ワークフローのタグを集めて、issue-deck 側の最新タグと
 * 突き合わせる（#985）。
 *
 * **なぜ要るか。** 共有ワークフローは `uses:` のタグ固定で配っており、issue-deck 側を
 * 直しても各リポジトリの caller を上げるまで反映されない。**上げ忘れても何も起きないので
 * 気づけない。** 実際 `workflows/v10` は car-care だけに配られ、他9リポジトリは v9 のまま
 * 数時間放置されていた（#1147 の修正が届いていない状態）。
 */

/** 共有ワークフローのタグを探す先。issue-deck 自身のリポジトリ */
const SOURCE_REPOSITORY = "guchi-apps/issue-deck";

/** 1ページで取れるタグ数。`workflows/v*` は多くないため1ページで足りる想定 */
const TAG_PAGE_SIZE = 100;

export type WorkflowTagOverview = {
  /** issue-deck 側の最新タグ。取得に失敗した場合は null */
  latest: string | null;
  repositories: WorkflowTagStatus[];
};

/** issue-deck のタグ一覧から最新の `workflows/vN` を取る */
async function fetchLatestTag(token: string): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${SOURCE_REPOSITORY}/tags?per_page=${TAG_PAGE_SIZE}`;
  const res = await githubFetch(url, token);
  if (!res.ok) return null;

  const tags: { name?: string }[] = await res.json();
  return latestWorkflowTag(tags.map((tag) => tag.name ?? ""));
}

/**
 * 1リポジトリぶんの caller を読む。
 *
 * `.github/workflows/` の一覧を取ってから各ファイルを読むため、リポジトリあたり
 * 1 + ワークフロー数のリクエストになる。**共有ワークフローを参照していないファイル
 * （`ci.yml`・`deploy.yml` 等）も読む必要がある**ため、ここは減らせない。
 */
async function fetchRefs(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<WorkflowTagRef[]> {
  const listUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/.github/workflows?ref=${branch}`;
  const listRes = await githubFetch(listUrl, token);
  if (!listRes.ok) return [];

  const entries: { name?: string; type?: string }[] = await listRes.json();
  const files = entries
    .filter((entry) => entry.type === "file" && entry.name?.endsWith(".yml"))
    .map((entry) => entry.name as string);

  const refs: WorkflowTagRef[] = [];
  for (const file of files) {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/.github/workflows/${file}?ref=${branch}`;
    const res = await githubFetch(url, token);
    if (!res.ok) continue;

    const data: { content?: string } = await res.json();
    if (typeof data.content !== "string") continue;

    const ref = extractWorkflowTagRef(file, Buffer.from(data.content, "base64").toString("utf8"));
    if (ref) refs.push(ref);
  }
  return refs;
}

/**
 * 対象リポジトリすべての参照状況を集める。
 *
 * 対象は**マルチエージェント対応かつアーカイブ済みでない**リポジトリ（既存の再同期と同じ条件）。
 * issue-deck 自身はローカルパス参照（`uses: ./.github/workflows/...`）でタグを持たないため、
 * 参照が見つからず結果に現れない。
 */
export async function collectWorkflowTags(userId: string): Promise<WorkflowTagOverview> {
  const repositories = await db.repository.findMany({
    where: {
      hasClaudeWorkflow: true,
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    select: {
      fullName: true,
      ownerLogin: true,
      name: true,
      defaultBranch: true,
      installation: { select: { installationId: true } },
    },
    orderBy: { fullName: "asc" },
  });

  if (repositories.length === 0) return { latest: null, repositories: [] };

  // インストールごとにトークンを取り直す。1ユーザーが複数インストールを持つことがある
  const tokens = new Map<number, string>();
  const tokenFor = async (installationId: number): Promise<string> => {
    const cached = tokens.get(installationId);
    if (cached) return cached;
    const token = await getInstallationToken(installationId);
    tokens.set(installationId, token);
    return token;
  };

  const firstToken = await tokenFor(repositories[0]!.installation.installationId);
  const latest = await fetchLatestTag(firstToken);

  const statuses: WorkflowTagStatus[] = [];
  for (const repository of repositories) {
    const token = await tokenFor(repository.installation.installationId);
    const refs = await fetchRefs(
      repository.ownerLogin,
      repository.name,
      repository.defaultBranch,
      token,
    );
    // 共有ワークフローを参照していないリポジトリは表示しても意味がないため落とす
    if (refs.length === 0) continue;
    statuses.push(evaluateWorkflowTags(repository.fullName, refs, latest));
  }

  return { latest, repositories: statuses };
}
