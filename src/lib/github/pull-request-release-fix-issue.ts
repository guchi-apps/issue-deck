import type { PullRequestSummary } from "@/types/pull-request";

/** 実機確認の結果を書く欄の見出し。下書きに入れ、起案した人が埋める */
export const RELEASE_FIX_ISSUE_OBSERVATION_HEADING = "## 実機で確認した内容";

/**
 * PR詳細の「修正Issueを起案」の対象か。マージ済みで、リリースPR（develop→main）以外のPR。
 * リリースPRの指摘は検証結果パネルの行ごとの「修正をIssueにする」が受け持つ。
 */
export function showsPullRequestFixIssueButton(
  pullRequest: Pick<PullRequestSummary, "merged" | "kind">,
): boolean {
  return pullRequest.merged && pullRequest.kind !== "release";
}

/**
 * リリース履歴で実機確認したところ、マージ済みのPRの変更が正しく反映されていなかったときに、
 * 修正Issueを起案するための下書き（新規Issue作成ダイアログに差し込む）を作る。
 *
 * **ここでは起票しない。** 立てるかは読んだ人が決める（`buildReleaseVerificationFixIssueDraft`と同じ立場）。
 * 対象PRのブランチは`delete_branch_on_merge=true`で消えているため、既存Issueへ追加対応を頼むのではなく
 * 対象PRを引用した新規Issueとして切り出す。
 */
export function buildPullRequestFixIssueDraft(
  pullRequest: Pick<
    PullRequestSummary,
    "repositoryFullName" | "number" | "title" | "mergedAt" | "linkedIssueNumber"
  >,
): { repositoryFullName: string; title: string; body: string } {
  const lines = [
    `${pullRequest.repositoryFullName} の #${pullRequest.number} をリリース後に実機で確認したところ、` +
      "意図どおりに反映されていませんでした。",
    "",
    `- 対象PR: #${pullRequest.number} ${pullRequest.title}`,
    ...(pullRequest.linkedIssueNumber !== null ? [`- 元Issue: #${pullRequest.linkedIssueNumber}`] : []),
    ...(pullRequest.mergedAt ? [`- マージ日時: ${pullRequest.mergedAt}`] : []),
    "",
    RELEASE_FIX_ISSUE_OBSERVATION_HEADING,
    "",
    "（何をしたら、どうなったか。期待していた動作との違いを書く）",
  ];

  return {
    repositoryFullName: pullRequest.repositoryFullName,
    title: `#${pullRequest.number} の修正: ${pullRequest.title}`,
    body: lines.join("\n"),
  };
}
