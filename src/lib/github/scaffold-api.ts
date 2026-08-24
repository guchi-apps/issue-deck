/**
 * 立ち上げで作ったリポジトリへ雛形一式をコミットする（#2247）。**サーバー専用。**
 *
 * 何を置くかの宣言は`lib/new-app/scaffold.ts`（純粋関数）が持ち、ここはGitHubとのやり取り
 * だけを担う。
 *
 * **1コミットにまとめる。** Contents APIで1ファイルずつPUTすると、ファイル数ぶんの
 * コミットが並び、途中で失敗したときに「どこまで置かれたのか」が履歴からしか分からない。
 * Git Data API（blob → tree → commit → ref）なら、失敗すればrefが動かないので
 * 「置かれたか、置かれていないか」の2択で済む。
 *
 * **`.github/workflows/`への書き込みにはWorkflows権限が要る。** issue-deckのGitHub Appは
 * `Workflows: Read and write`を持つ（docs/github-app-permissions.md）が、権限が外れると
 * ここだけが403で落ちる。呼び出し側は**この失敗で立ち上げを止めない**——雛形が無くても
 * 初期化Issueは従来どおり実装できる。
 */

import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import type { ScaffoldCopy, ScaffoldFile } from "@/lib/new-app/scaffold";
import type { NewAppSpec } from "@/lib/new-app/spec";

/** 雛形の配布元。**`main`から読む**（developの内容を新しいリポジトリへ配らない）。 */
const SOURCE_REPOSITORY = "guchi-apps/issue-deck";
const SOURCE_REF = "main";

/** 通常ファイルと実行ファイルのGitモード。 */
const MODE_FILE = "100644";
const MODE_EXECUTABLE = "100755";

async function requestJson<T>(
  url: string,
  token: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
): Promise<T> {
  const res = await githubFetch(url, token, { method, body });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * issue-deckの`main`からファイルの中身を読む。
 *
 * `githubFetch`は`Accept`を`application/vnd.github+json`で上書きするため
 * `application/vnd.github.raw`は使えない。base64の`content`を自分で戻す
 * （docs/new-app-launch.md）。
 */
async function fetchSourceFile(token: string, path: string): Promise<string> {
  const url = `${GITHUB_API}/repos/${SOURCE_REPOSITORY}/contents/${path}?ref=${SOURCE_REF}`;
  const file = await requestJson<{ content?: string; encoding?: string }>(url, token, "GET");
  if (!file.content || file.encoding !== "base64") {
    throw new Error(`${SOURCE_REPOSITORY} の ${path} を読み取れませんでした。`);
  }
  return Buffer.from(file.content, "base64").toString("utf8");
}

export type ResolvedCopies = {
  files: ScaffoldFile[];
  /** 読めなかった・書き換えの目印が見つからなかったもの（画面へ警告として返す） */
  problems: string[];
};

/**
 * 「issue-deckの実物をそのまま配る」ファイルを読んで、置ける形にする。
 *
 * **1つ読めなくても残りは配る。** 読めなかったものは`problems`として返し、呼び出し側が
 * 警告に載せる。ここで例外にすると、通知スクリプト1本のために雛形が丸ごと置かれなくなる。
 */
export async function resolveScaffoldCopies(
  token: string,
  spec: NewAppSpec,
  copies: ScaffoldCopy[],
): Promise<ResolvedCopies> {
  const files: ScaffoldFile[] = [];
  const problems: string[] = [];

  for (const copy of copies) {
    let content: string;
    try {
      content = await fetchSourceFile(token, copy.source);
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 401) throw error;
      problems.push(`${copy.path}（配布元 ${copy.source} を読めませんでした）`);
      continue;
    }
    if (copy.rewrite) {
      if (!content.includes(copy.rewrite.anchor)) {
        // 目印が消えている＝配布元の書式が変わった。書き換えないまま置くと、
        // issue-deck自身を指したままのスクリプトが新しいリポジトリで動くことになる。
        problems.push(`${copy.path}（配布元の書式が変わったため書き換えられませんでした）`);
        continue;
      }
      content = content.split(copy.rewrite.anchor).join(copy.rewrite.replacement(spec));
    }
    files.push({ path: copy.path, content, executable: copy.executable });
  }

  return { files, problems };
}

export type ScaffoldCommitResult = {
  /** 作ったコミットのSHA */
  sha: string;
  /** コミットしたファイル数 */
  fileCount: number;
};

/**
 * 雛形を1コミットで置く。
 *
 * `branch`の先端を親にして、既存のツリーへ重ねる（`base_tree`）。`auto_init`が入れた
 * READMEは同名のパスを置けば上書きされる。
 */
export async function commitScaffoldFiles(
  owner: string,
  repo: string,
  token: string,
  params: { branch: string; message: string; files: ScaffoldFile[] },
): Promise<ScaffoldCommitResult> {
  const base = `${GITHUB_API}/repos/${owner}/${repo}`;

  const head = await requestJson<{ object: { sha: string } }>(
    `${base}/git/ref/heads/${params.branch}`,
    token,
    "GET",
  );
  const parent = head.object.sha;
  const parentCommit = await requestJson<{ tree: { sha: string } }>(
    `${base}/git/commits/${parent}`,
    token,
    "GET",
  );

  const entries: { path: string; mode: string; type: "blob"; sha: string }[] = [];
  for (const file of params.files) {
    const blob = await requestJson<{ sha: string }>(`${base}/git/blobs`, token, "POST", {
      content: Buffer.from(file.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    entries.push({
      path: file.path,
      mode: file.executable ? MODE_EXECUTABLE : MODE_FILE,
      type: "blob",
      sha: blob.sha,
    });
  }

  const tree = await requestJson<{ sha: string }>(`${base}/git/trees`, token, "POST", {
    base_tree: parentCommit.tree.sha,
    tree: entries,
  });
  const commit = await requestJson<{ sha: string }>(`${base}/git/commits`, token, "POST", {
    message: params.message,
    tree: tree.sha,
    parents: [parent],
  });
  await requestJson(`${base}/git/refs/heads/${params.branch}`, token, "PATCH", {
    sha: commit.sha,
  });

  return { sha: commit.sha, fileCount: params.files.length };
}
