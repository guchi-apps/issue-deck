/**
 * `guchi-apps/ideas`から構想メモを取ってくる（#2432）。**サーバー専用。**
 *
 * 解析そのものは`lib/new-app/idea-doc.ts`（純粋関数）が持つ。ここは取得だけを担う
 * （`vps-inventory-api.ts`と同じ切り分け）。
 *
 * **読めなかったときは例外にせず`null`を返す。** 構想から読み込めないだけで、ウィザードは
 * 手入力で最後まで進められる。ここで止めると、構想の置き場を読む権限が無いだけで
 * 立ち上げの導線ごと使えなくなる。
 */

import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { GithubApiError } from "@/lib/github/github-api-error";
import {
  IDEA_DIRECTORY,
  IDEA_REPOSITORY_NAME,
  IDEA_REPOSITORY_OWNER,
  isIdeaDocPath,
  parseIdeaDoc,
} from "@/lib/new-app/idea-doc";

/** 一覧に出す構想メモ1件。 */
export type IdeaDocRef = {
  /** `ideas/<候補名>` のディレクトリ名 */
  name: string;
  /** `ideas/<候補名>/README.md` */
  path: string;
};

/** 構想メモ1件の中身。 */
export type IdeaDocContent = {
  path: string;
  markdown: string;
};

export type IdeaSummary = IdeaDocRef & {
  title: string;
  state: string | null;
  summary: string | null;
  markdown: string;
};

/** 人が手で書くMarkdownなので、桁違いに大きいものは読まない。 */
const MAX_IDEA_BYTES = 200_000;

type ContentsEntry = { name?: string; path?: string; type?: string };

/**
 * 構想メモの一覧。`ideas/`直下のディレクトリを1リクエストで読む。
 *
 * **`README.md`があるかまでは確かめない**（1件1リクエストになるため）。無ければ
 * 読み込み時に`null`が返り、画面が「読めませんでした」を出す。
 */
export async function listIdeaDocs(token: string): Promise<IdeaDocRef[] | null> {
  const res = await githubFetch(
    `${GITHUB_API}/repos/${IDEA_REPOSITORY_OWNER}/${IDEA_REPOSITORY_NAME}/contents/${IDEA_DIRECTORY}`,
    token,
  );
  if (res.status === 401) throw new GithubApiError(401, "GitHub API request failed: 401 ideas list");
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as ContentsEntry[] | null;
  if (!Array.isArray(json)) return null;

  return json
    .filter((entry) => entry.type === "dir" && typeof entry.name === "string")
    .map((entry) => ({ name: entry.name as string, path: `${IDEA_DIRECTORY}/${entry.name}/README.md` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 構想メモの本文。
 *
 * **パスは`ideas/`配下の`.md`に限る。** 画面から来た文字列をそのままGitHubのcontents APIへ
 * 渡す経路なので、リポジトリの他の場所（`CLAUDE.md`など）を読める形にしない。
 */
export async function fetchIdeaDoc(token: string, path: string): Promise<IdeaDocContent | null> {
  if (!isIdeaDocPath(path)) return null;

  const res = await githubFetch(
    `${GITHUB_API}/repos/${IDEA_REPOSITORY_OWNER}/${IDEA_REPOSITORY_NAME}/contents/${path}`,
    token,
  );
  if (res.status === 401) throw new GithubApiError(401, "GitHub API request failed: 401 idea document");
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as
    | { content?: string; encoding?: string; size?: number }
    | null;
  if (!json?.content || json.encoding !== "base64") return null;
  if (typeof json.size === "number" && json.size > MAX_IDEA_BYTES) return null;

  return { path, markdown: Buffer.from(json.content, "base64").toString("utf8") };
}

/** 一覧画面向けに本文も読む。1件だけ壊れていても、残りの構想は表示する。 */
export async function listIdeaSummaries(token: string): Promise<IdeaSummary[] | null> {
  const refs = await listIdeaDocs(token);
  if (refs === null) return null;
  const entries = await Promise.all(
    refs.map(async (ref) => {
      const doc = await fetchIdeaDoc(token, ref.path);
      if (!doc) return null;
      const parsed = parseIdeaDoc(doc.markdown);
      const title = parsed.title || ref.name;
      const state = parsed.state;
      const summary = doc.markdown
        .replace(/^#.*$/gm, "")
        .replace(/^[-*]\s*状態\s*[:：].*$/gm, "")
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
        .find((paragraph) => paragraph.length > 0 && !paragraph.startsWith("|")) ?? null;
      return { ...ref, title, state, summary, markdown: doc.markdown };
    }),
  );
  return entries.filter((entry): entry is IdeaSummary => entry !== null);
}

function ideaDirectoryFromPath(path: string): string | null {
  if (!isIdeaDocPath(path)) return null;
  const parts = path.split("/");
  return parts.length === 3 ? `${parts[0]}/${parts[1]}` : null;
}

async function requireJson<T>(res: Response, url: string, allowTokenRefresh = true): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 書き込み開始後の401をGithubApiErrorにすると、withUserGithubTokenが処理全体を再実行して
    // コミットを二重作成する。トークン延長を許すのは読み取り段階だけにする。
    if (!allowTokenRefresh) {
      throw new Error(`GitHub API request failed after mutation started: ${res.status} ${url} ${detail}`);
    }
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * 構想ディレクトリを1コミットで削除する。
 * Contents APIをファイルごとに呼ぶと途中失敗で半端に残るため、Git Trees APIでまとめる。
 */
export async function deleteIdeaDirectory(token: string, path: string): Promise<boolean> {
  const directory = ideaDirectoryFromPath(path);
  if (!directory) return false;
  const repoUrl = `${GITHUB_API}/repos/${IDEA_REPOSITORY_OWNER}/${IDEA_REPOSITORY_NAME}`;
  const repo = await requireJson<{ default_branch: string }>(await githubFetch(repoUrl, token), repoUrl);
  const refUrl = `${repoUrl}/git/ref/heads/${encodeURIComponent(repo.default_branch)}`;
  const ref = await requireJson<{ object: { sha: string } }>(await githubFetch(refUrl, token), refUrl);
  const commitUrl = `${repoUrl}/git/commits/${ref.object.sha}`;
  const commit = await requireJson<{ tree: { sha: string } }>(await githubFetch(commitUrl, token), commitUrl);
  const treeUrl = `${repoUrl}/git/trees/${commit.tree.sha}?recursive=1`;
  const tree = await requireJson<{ tree: { path: string; type: string; mode: string }[] }>(
    await githubFetch(treeUrl, token),
    treeUrl,
  );
  const files = tree.tree.filter(
    (entry) => entry.type === "blob" && entry.path.startsWith(`${directory}/`),
  );
  if (files.length === 0) return false;

  const createTreeUrl = `${repoUrl}/git/trees`;
  const nextTree = await requireJson<{ sha: string }>(
    await githubFetch(createTreeUrl, token, {
      method: "POST",
      body: {
        base_tree: commit.tree.sha,
        tree: files.map((entry) => ({ path: entry.path, mode: entry.mode, type: "blob", sha: null })),
      },
    }),
    createTreeUrl,
    false,
  );
  const createCommitUrl = `${repoUrl}/git/commits`;
  const nextCommit = await requireJson<{ sha: string }>(
    await githubFetch(createCommitUrl, token, {
      method: "POST",
      body: {
        message: `構想「${directory.slice(IDEA_DIRECTORY.length + 1)}」を削除`,
        tree: nextTree.sha,
        parents: [ref.object.sha],
      },
    }),
    createCommitUrl,
    false,
  );
  await requireJson(
    await githubFetch(`${repoUrl}/git/refs/heads/${encodeURIComponent(repo.default_branch)}`, token, {
      method: "PATCH",
      body: { sha: nextCommit.sha },
    }),
    refUrl,
    false,
  );
  return true;
}
