import type { IssuePullRequest } from "@/types/pull-request";

/**
 * 取得したPRのうち、このIssueの対応PRとして表示してよいものだけを残す（#1339）。
 *
 * 対応PRの候補はIssueコメント中のPR URL（`lib/github/pull-request-link.ts`）から拾うため、
 * 「#1327を参考に」のような単なる言及も混ざる。1件（最新）だけを出していた頃は誤検出しても
 * 影響が限定的だったが、全件を並べるようになると無関係なPRがそのまま画面に出てしまう。
 *
 * そこでPR側から推定した対応Issue番号（`extractLinkedIssueNumber`）を突き合わせ、
 * **明確に別のIssueに紐づくPRだけ**を落とす。推定できなかった（`linkedIssueNumber`がnullの）
 * PRは残す。ブランチ名が`issue-<番号>`規約から外れているだけの正当な対応PRを、
 * 推定できないという理由で消さないため。
 */
export function selectIssuePullRequests(
  pullRequests: IssuePullRequest[],
  issueNumber: number,
): IssuePullRequest[] {
  return pullRequests
    .filter((pr) => pr.linkedIssueNumber === null || pr.linkedIssueNumber === issueNumber)
    .sort((a, b) => a.number - b.number);
}

/**
 * この対応PRにマージボタンを出してよいか。
 *
 * マージできるのはまだopenで、下書きでもマージ済みでもないPRだけ。CI実行中に押させない判定は
 * ボタン側（`IssueMergeButton`の`ciStatus`）が持つので、ここには含めない。
 */
export function canMergeIssuePullRequest(pullRequest: IssuePullRequest): boolean {
  return pullRequest.state === "open" && !pullRequest.draft && !pullRequest.merged;
}

/** 対応PRの状態を表すラベル。画面の状態バッジに使う */
export type IssuePullRequestStateLabel = "draft" | "open" | "merged" | "closed";

export function issuePullRequestStateLabel(
  pullRequest: IssuePullRequest,
): IssuePullRequestStateLabel {
  if (pullRequest.merged) return "merged";
  if (pullRequest.state === "closed") return "closed";
  return pullRequest.draft ? "draft" : "open";
}
