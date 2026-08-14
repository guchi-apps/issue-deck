/**
 * 画面に出てくるGitHubのIssue・PRへのリンクを、アプリ内で開くための参照に変換する（#1260）。
 *
 * 本文・コメント中のURLや`#123`は最終的に`https://github.com/<owner>/<repo>/(issues|pull)/<番号>`の
 * 形になっている（`#123`は`rehype-linkify-issue-refs.ts`がこの形へ展開する）。表示側は
 * リンクのURLしか持っていないため、ここで「どのリポジトリの何番か」を取り出して、
 * IssueDeckの画面内遷移（`github-reference-navigation.tsx`）へ渡す。
 */

/**
 * 参照先の種別。GitHubは`/issues/<番号>`でPRも開ける（同じ番号空間のため）ので、
 * `issue`は「Issueとして開いてみる」意味しか持たない。実際にPRだった場合の
 * フォールバックは遷移側（`IssueDeckShell`）が受け持つ。
 */
export type GithubReferenceKind = "issue" | "pull";

export type GithubReference = {
  repositoryFullName: string;
  number: number;
  kind: GithubReferenceKind;
};

// owner/repoに`/`・空白・クエリ/フラグメント区切りは現れない。末尾は`/files`のようなサブパスや
// `#issuecomment-...`が続くことがあるため、番号の後ろは自由に残す。
const GITHUB_REFERENCE_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/(issues|pull)\/(\d+)(?:[/?#]|$)/;

/** GitHubのIssue・PRのURLを参照へ変換する。対象外のURL（Actionsのログ等）はnull */
export function parseGithubReferenceUrl(url: string): GithubReference | null {
  const match = GITHUB_REFERENCE_PATTERN.exec(url.trim());
  if (!match) return null;

  const [, owner, repo, path, number] = match;
  return {
    repositoryFullName: `${owner}/${repo}`,
    number: Number(number),
    kind: path === "pull" ? "pull" : "issue",
  };
}

/** PR一覧・PR詳細の選択状態に使う識別子（`<owner>/<repo>#<番号>`） */
export function buildPullRequestId(repositoryFullName: string, number: number): string {
  return `${repositoryFullName}#${number}`;
}

/** `buildPullRequestId`の逆変換。URLクエリ（`?pr=`）から復元するために使う */
export function parsePullRequestId(
  id: string,
): { repositoryFullName: string; number: number } | null {
  const match = /^([^/\s]+\/[^/#\s]+)#(\d+)$/.exec(id);
  if (!match) return null;
  return { repositoryFullName: match[1], number: Number(match[2]) };
}
