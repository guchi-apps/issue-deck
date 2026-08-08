import type { Issue } from "@/types/issue";

/**
 * 「続きのIssueを作成」機能で、新規Issueの本文欄に自動入力する初期テキストを組み立てる。
 *
 * 作成先リポジトリは元Issueと異なるリポジトリへ切り替えられる可能性があるため、`#<番号>`のみの
 * 参照ではなく、リポジトリ名とフルURLを含める（`buildClaudeAppPrompt`と同じ考え方）。フルURLは
 * GitHub・issue-deckどちらのMarkdownレンダラでも素のURLとして自動リンク化されるため、作成先
 * リポジトリが元Issueと異なっていても常に正しいリンクとして機能する（#815）。
 */
export function buildFollowupIssueBody(
  issue: Pick<Issue, "repositoryFullName" | "number" | "title" | "htmlUrl">,
): string {
  return `## ${issue.repositoryFullName} の Issue #${issue.number}「${issue.title}」に関連する対応です\n\n${issue.htmlUrl}\n\n`;
}
