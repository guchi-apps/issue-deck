"use client";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { ReviewFixSessionButton } from "@/components/dashboard/review-fix-session-button";
import { issueReviewFixRequestState, resolveReviewFixSessionRoute } from "@/lib/dispatch/review-fix-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { needsReviewAttention } from "@/lib/github/pull-request-review-verdict";
import { cn } from "@/lib/utils";
import type { IssueComment } from "@/types/issue";
import type { IssuePullRequest } from "@/types/pull-request";

/**
 * Issue詳細で直せるレビュー指摘があるPRを1件選ぶ（#5493）。openで、このIssueのブランチのPRで、
 * いまのHEADに対する要修正・要確認があり、自動修正が走っていないもの。
 */
export function selectReviewFixPullRequest(
  pullRequests: readonly IssuePullRequest[],
  issueNumber: number,
): IssuePullRequest | null {
  return (
    pullRequests.find(
      (pullRequest) =>
        pullRequest.state === "open" &&
        !pullRequest.merged &&
        !pullRequest.draft &&
        pullRequest.linkedIssueNumber === issueNumber &&
        pullRequest.repairRun === null &&
        pullRequest.reviewVerdict !== null &&
        needsReviewAttention(pullRequest.reviewVerdict.reviewKind) &&
        pullRequest.reviewVerdict.reviewedSha === pullRequest.headSha,
    ) ?? null
  );
}

/**
 * Issue詳細の「PR #N の自動レビューが要修正です」の帯（#5493）。
 *
 * これまでIssueへ戻っても「セッションを復旧」（指摘を渡さない再開）しか無く、PRの指摘と
 * 結びついていなかった。ここから押すと、PR詳細の「Issueのセッションで直す」と同じ依頼になる
 * （同じボタン・同じAPI）。「セッションを復旧」はそのまま残す。
 */
export function IssueReviewFixBand({
  repositoryFullName,
  issueNumber,
  pullRequests,
  session,
  comments,
  onRequested,
  className,
}: {
  repositoryFullName: string;
  issueNumber: number;
  pullRequests: readonly IssuePullRequest[];
  session: DispatchSessionView | null;
  comments: readonly IssueComment[];
  onRequested?: () => void;
  className?: string;
}) {
  const pullRequest = selectReviewFixPullRequest(pullRequests, issueNumber);
  if (!pullRequest || !pullRequest.reviewVerdict) return null;

  const needsCheck = pullRequest.reviewVerdict.reviewKind === "needs-check";
  const verdictLabel = needsCheck ? "要確認" : "要修正";
  const requestState = issueReviewFixRequestState(comments, pullRequest.headSha);
  const route = resolveReviewFixSessionRoute(session);
  const prReference = { repositoryFullName, number: pullRequest.number, kind: "pull" as const };

  return (
    <section
      aria-label={`PR #${pullRequest.number} のレビュー指摘`}
      data-testid="issue-review-fix-band"
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        needsCheck ? "border-sky-500/50 bg-sky-50 dark:bg-sky-950/30" : "border-amber-500/60 bg-amber-50 dark:bg-amber-950/30",
        className,
      )}
    >
      <h3 className={cn("text-sm font-bold", needsCheck ? "text-sky-800 dark:text-sky-300" : "text-amber-800 dark:text-amber-300")}>
        <span aria-hidden="true">{needsCheck ? "◇" : "▲"}</span> PR #{pullRequest.number} の自動レビューが{verdictLabel}です
      </h3>
      {requestState === "requested" ? (
        <p className="text-xs text-muted-foreground">
          このコミット（{pullRequest.headSha.slice(0, 7)}）への修正を、このIssueのセッションへ依頼済みです。pushされるとCI・再レビューが自動で走ります（操作は不要です）。
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {requestState === "interrupted" && "前回の依頼はセッションへ届いていません。"}
          指摘をこのIssueのコメントにまとめ、このIssueのセッションで同じPRを直させます（新しいIssue・PRは作りません）。「セッションを復旧」は指摘を渡さずに再開します。
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {requestState !== "requested" && (
          <ReviewFixSessionButton
            repositoryFullName={repositoryFullName}
            pullRequestNumber={pullRequest.number}
            headSha={pullRequest.headSha}
            headRef={`issue-${issueNumber}`}
            issueNumber={issueNumber}
            route={route}
            verdictLabel={verdictLabel}
            concerns={[]}
            reviewUrl={pullRequest.htmlUrl}
            label="このセッションで直す"
            variant="default"
            onRequested={onRequested}
          />
        )}
        <GithubReferenceLink
          href={pullRequest.htmlUrl}
          reference={prReference}
          className="inline-flex h-9 items-center rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted"
        >
          PR #{pullRequest.number} の指摘を見る
        </GithubReferenceLink>
      </div>
    </section>
  );
}
