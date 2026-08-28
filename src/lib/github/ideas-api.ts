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
import {
  IDEA_DIRECTORY,
  IDEA_REPOSITORY_NAME,
  IDEA_REPOSITORY_OWNER,
  isIdeaDocPath,
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
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as
    | { content?: string; encoding?: string; size?: number }
    | null;
  if (!json?.content || json.encoding !== "base64") return null;
  if (typeof json.size === "number" && json.size > MAX_IDEA_BYTES) return null;

  return { path, markdown: Buffer.from(json.content, "base64").toString("utf8") };
}
