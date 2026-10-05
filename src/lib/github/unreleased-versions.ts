import {
  fetchDeployRunForSha,
  fetchReleaseNotesFile,
  fetchTagRefs,
  type ReleaseHistoryItem,
} from "@/lib/github/release-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  applyRecoveryLinks,
  findPreviousVersionTag,
  parseReleaseNotesSnapshot,
  planRecoveryLinks,
  resolveUnreleasedDeployState,
  selectUnreleasedTags,
  toVersionTags,
  type ReleaseNotesSnapshot,
  type VersionTag,
} from "@/lib/release-recovery";

/**
 * GitHub Releaseが無い版をタグから補い、修正版との関係を付ける（#4003。判定は`lib/release-recovery.ts`）。
 *
 * **タグ・説明ファイル・タグ間のPR一覧・祖先関係は、一度取れたら変わらない**ので、プロセス内で
 * 覚えておく（リリース履歴を開くたびに取り直さない）。デプロイの状態だけは再実行で変わるため
 * 毎回取る。対象はReleaseの無いタグだけなので、平常時（全版にReleaseがある）は
 * タグ一覧（ETag付き）の1回で終わる。
 */

const MEMO_LIMIT = 500;
const memo = new Map<string, unknown>();

async function remember<T>(key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T> {
  if (memo.has(key)) return memo.get(key) as T;
  const value = await load();
  if (keep(value)) {
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
    memo.set(key, value);
  }
  return value;
}

/** テストから覚えた値を捨てる */
export function clearUnreleasedVersionsMemo(): void {
  memo.clear();
}

/** タグが指すコミットの日時。取れなければnull */
async function fetchTagCommitDate(owner: string, repo: string, tagName: string, token: string): Promise<string | null> {
  return remember(
    `date ${owner}/${repo} ${tagName}`,
    async () => {
      const res = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(tagName)}`, token);
      if (!res.ok) return null;
      const data: { commit?: { committer?: { date?: string } } } = await res.json().catch(() => ({}));
      return data.commit?.committer?.date ?? null;
    },
    (value) => value !== null,
  );
}

/** その版の説明。取得に失敗したときは理由付きで返す（覚えない） */
async function fetchNotesSnapshot(
  owner: string,
  repo: string,
  tagName: string,
  token: string,
): Promise<ReleaseNotesSnapshot> {
  return remember(
    `notes ${owner}/${repo} ${tagName}`,
    async (): Promise<ReleaseNotesSnapshot | null> => {
      try {
        return parseReleaseNotesSnapshot(await fetchReleaseNotesFile(owner, repo, tagName, token), tagName);
      } catch {
        return null;
      }
    },
    (value) => value !== null,
  ).then((value) => value ?? { status: "unavailable", reason: "説明ファイルの取得に失敗しました" });
}

/**
 * 2つのタグの間にマージされたPRの一覧を、GitHubにReleaseの本文と同じ形式で生成させる。
 * **Releaseを作らない読み取り専用のAPI**で、通常の版の`body`（`generate_release_notes: true`）と
 * 同じ書式になるため、箇条書きの抽出・行チェックをそのまま使える。取れなければnull。
 */
async function fetchGeneratedNotes(
  owner: string,
  repo: string,
  tagName: string,
  previousTagName: string | null,
  token: string,
): Promise<string | null> {
  return remember(
    `generated ${owner}/${repo} ${previousTagName ?? ""}...${tagName}`,
    async () => {
      const res = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/releases/generate-notes`, token, {
        method: "POST",
        body: { tag_name: tagName, ...(previousTagName ? { previous_tag_name: previousTagName } : {}) },
      });
      if (!res.ok) return null;
      const data: { body?: string } = await res.json().catch(() => ({}));
      return typeof data.body === "string" ? data.body : null;
    },
    (value) => value !== null,
  );
}

/** `head`が`base`を含むか（Gitの祖先関係）。取れなければnull */
async function fetchContains(
  owner: string,
  repo: string,
  base: string,
  head: string,
  token: string,
): Promise<boolean | null> {
  return remember(
    `contains ${owner}/${repo} ${base}...${head}`,
    async () => {
      const res = await githubFetch(
        `${GITHUB_API}/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
        token,
      );
      if (!res.ok) return null;
      const data: { status?: string } = await res.json().catch(() => ({}));
      if (data.status === "ahead" || data.status === "identical") return true;
      if (data.status === "behind" || data.status === "diverged") return false;
      return null;
    },
    (value) => value !== null,
  );
}

async function buildUnreleasedEntry(
  owner: string,
  repo: string,
  tag: VersionTag,
  allTags: readonly VersionTag[],
  token: string,
): Promise<ReleaseHistoryItem | null> {
  const previous = findPreviousVersionTag(allTags, tag.tagName);
  const [publishedAt, run, releaseNotes, body] = await Promise.all([
    fetchTagCommitDate(owner, repo, tag.tagName, token),
    fetchDeployRunForSha(owner, repo, token, tag.sha).catch(() => null),
    fetchNotesSnapshot(owner, repo, tag.tagName, token),
    fetchGeneratedNotes(owner, repo, tag.tagName, previous, token),
  ]);
  // 時系列に置けない版は出せない（`mergeReleaseHistory`が捨てる）
  if (!publishedAt) return null;
  return {
    repoFullName: `${owner}/${repo}`,
    tagName: tag.tagName,
    name: tag.tagName,
    htmlUrl: `https://github.com/${owner}/${repo}/tree/${tag.tagName}`,
    publishedAt,
    body,
    deployState: resolveUnreleasedDeployState(run),
    releaseNotes,
    ...(body === null ? { bodyUnavailableReason: "この版に含まれるPRの一覧を取得できませんでした" } : {}),
  };
}

/**
 * 1リポジトリぶんのReleaseの一覧へ、Releaseが無い版を足して修正版と紐付ける。
 * **失敗しても元の一覧はそのまま返す**（補えないことで履歴全体を消さない）。
 */
export async function appendUnreleasedVersions(
  owner: string,
  repo: string,
  token: string,
  releases: ReleaseHistoryItem[],
): Promise<ReleaseHistoryItem[]> {
  if (releases.length === 0) return releases;
  try {
    const tags = toVersionTags(await fetchTagRefs(owner, repo, token, "v"));
    const unreleasedTags = selectUnreleasedTags(tags, releases);
    if (unreleasedTags.length === 0) return releases;

    const unreleased = (
      await Promise.all(unreleasedTags.map((tag) => buildUnreleasedEntry(owner, repo, tag, tags, token)))
    ).filter((entry): entry is ReleaseHistoryItem => entry !== null);
    const combined = [...releases, ...unreleased];

    const candidates = planRecoveryLinks(combined);
    const contains = await Promise.all(
      candidates.map((pair) => fetchContains(owner, repo, pair.failed, pair.recovery, token)),
    );
    // 祖先関係を確かめられた組だけを使う。版の並びだけで関係を言い切らない
    return applyRecoveryLinks(
      combined,
      candidates.filter((_, index) => contains[index] === true),
    );
  } catch (error) {
    console.error(`[appendUnreleasedVersions] ${owner}/${repo}:`, error);
    return releases;
  }
}
