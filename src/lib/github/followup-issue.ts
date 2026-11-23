import type { Issue } from "@/types/issue";

/**
 * 「引き継いでIssueを作成」機能で、新規Issueの本文の**先頭に固定で付く**テキストを組み立てる。
 *
 * 作成先リポジトリは元Issueと異なるリポジトリへ切り替えられる可能性があるため、`#<番号>`のみの
 * 参照ではなく、リポジトリ名とフルURLを含める。フルURLは
 * GitHub・issue-deckどちらのMarkdownレンダラでも素のURLとして自動リンク化されるため、作成先
 * リポジトリが元Issueと異なっていても常に正しいリンクとして機能する（#815）。
 *
 * **このテキストは本文の入力欄には入れない**（#1322）。入力欄へ初期値として流し込むと、ユーザーは
 * 毎回その下へ改行してから書き始める必要があり、消さないよう気を遣う対象にもなっていた。作成時に
 * `composeIssueBody`で入力内容の前へ連結する。
 */
export function buildFollowupIssueBodyPrefix(
  issue: Pick<Issue, "repositoryFullName" | "number" | "title" | "htmlUrl">,
): string {
  return `## ${issue.repositoryFullName} の Issue #${issue.number}「${issue.title}」に関連する対応です\n\n${issue.htmlUrl}\n\n`;
}

/**
 * 本文の固定接頭辞（引き継ぎ元の情報など）と、ユーザーが入力した本文を連結して実際に作成する
 * 本文を組み立てる（#1322）。
 *
 * 接頭辞が無い通常の作成では入力内容をそのまま返す。入力が空の場合に接頭辞の末尾の空行だけが
 * 残らないよう落とし、接頭辞と入力の間には必ず空行を1つ挟む（Markdownで段落が繋がらないため）。
 */
export function composeIssueBody(bodyPrefix: string | null | undefined, body: string): string {
  if (!bodyPrefix) return body;
  if (!body.trim()) return bodyPrefix.trimEnd();
  const separator = bodyPrefix.endsWith("\n\n") ? "" : bodyPrefix.endsWith("\n") ? "\n" : "\n\n";
  return `${bodyPrefix}${separator}${body}`;
}

/**
 * 「引き継いでIssueを作成」で、新規Issueのタイトルの先頭に**固定で付く**接頭辞（#5623）。
 * 一覧で「何の修正か」が分かるよう、元Issue番号を入れる。本文の接頭辞と同じく入力欄には入れない。
 */
export function buildFollowupIssueTitlePrefix(issue: Pick<Issue, "number">): string {
  return `修正 #${issue.number}:`;
}

/**
 * タイトルの固定接頭辞と入力（またはAIが付けた）タイトルを連結する。
 * 入力が既に接頭辞で始まっている場合は付け足さない（二重付与の防止）。入力が空なら接頭辞だけにはしない。
 */
export function composeIssueTitle(titlePrefix: string | null | undefined, title: string): string {
  if (!titlePrefix) return title;
  const trimmed = title.trim();
  if (!trimmed) return title;
  if (trimmed.startsWith(titlePrefix)) return trimmed;
  return `${titlePrefix} ${trimmed}`;
}
