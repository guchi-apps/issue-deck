import type { Issue } from "@/types/issue";

/**
 * 「引き継いでIssueを作成」機能で、新規Issueの本文の**先頭に固定で付く**テキストを組み立てる。
 *
 * 作成先リポジトリは元Issueと異なるリポジトリへ切り替えられる可能性があるため、`#<番号>`のみの
 * 参照ではなく、リポジトリ名とフルURLを含める（`buildClaudeAppPrompt`と同じ考え方）。フルURLは
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
