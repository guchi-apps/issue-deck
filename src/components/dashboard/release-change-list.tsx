"use client";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { ReviewVerdictFreshnessNote, VerdictText } from "@/components/dashboard/review-verdict";
import { useReleaseChanges } from "@/hooks/use-release-changes";
import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";
import { tallyReleaseReviews } from "@/lib/release-changes";
import type { ReleaseChangePullRequest } from "@/types/pull-request";

type ReleaseChangeListProps = {
  repositoryFullName: string;
  /** 確認ダイアログを開いているか。閉じている間は取得しない */
  enabled: boolean;
  /** 作成済みリリースPRの番号。あればその固定範囲を表示する（後からdevelopへ入った変更を混ぜない） */
  releasePullRequestNumber?: number | null;
};

/**
 * そのPR1本ぶんの自動レビュー判定の行（#4245）。本番マージ確認の「コードレビュー」
 * （`PullRequestMergeReview`）と同じ語彙・同じ`VerdictText`で出す。判定の材料はPR作成時に
 * 本文へ記録済みの節で、リリース起動時に読み直す。バンプPRはレビューの対象ではないので出さない。
 */
function ReleaseChangeReview({
  pr,
  prUrl,
}: {
  pr: ReleaseChangePullRequest;
  prUrl: string;
}) {
  if (pr.isVersionBump) return null;
  if (pr.reviewUnavailable) {
    return (
      <p className="pl-3 text-destructive">
        レビューを取得できませんでした（記録なしではありません）。PRで確認してください。
      </p>
    );
  }
  const { review } = pr;
  if (review === null) {
    return <p className="pl-3 text-muted-foreground">レビューの記録がありません</p>;
  }
  const freshness = resolveReviewVerdictFreshness({
    reviewedSha: review.reviewedSha,
    headSha: pr.prHeadSha,
  });
  return (
    <div className="flex flex-col gap-0.5 pl-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="text-muted-foreground">自動レビュー</span>
        <VerdictText kind={review.reviewKind} label={review.reviewLabel} />
        <span className="text-muted-foreground">機械的リスク</span>
        <span
          className={
            review.riskKind === "hit" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
          }
        >
          {review.riskLabel}
        </span>
        <GithubReferenceLink href={prUrl} className="ml-auto underline">
          レビューを読む
        </GithubReferenceLink>
      </div>
      {review.riskReasons.map((reason) => (
        <p key={reason} className="pl-2 text-[11px] text-muted-foreground">
          ・{reason}
        </p>
      ))}
      <ReviewVerdictFreshnessNote
        freshness={freshness}
        reviewedSha={review.reviewedSha}
        headSha={pr.prHeadSha}
        isReviewing={false}
      />
    </div>
  );
}

/**
 * リリース起動確認の「今回反映する内容」（PR単位。#4201）。PC・スマホで共通。
 *
 * 取得中・取得失敗・変更0件・PRに対応づかないコミットを区別して出す。失敗を0件として
 * 見せないのが要点で、「出す変更がありません」と誤認したまま起動させない。
 */
export function ReleaseChangeList({
  repositoryFullName,
  enabled,
  releasePullRequestNumber = null,
}: ReleaseChangeListProps) {
  const { data, isLoading, error } = useReleaseChanges(
    repositoryFullName,
    enabled,
    releasePullRequestNumber,
  );
  const tally = data ? tallyReleaseReviews(data.pullRequests) : null;
  const prUrl = (number: number) => `https://github.com/${repositoryFullName}/pull/${number}`;

  if (error) {
    return (
      <p className="text-xs text-destructive">
        今回反映する内容を取得できませんでした（{error}）。変更0件ではありません。GitHubで差分を確認してください。
      </p>
    );
  }
  if (isLoading || !data) {
    return <p className="text-xs text-muted-foreground">今回反映する内容を取得中...</p>;
  }
  if (data.pullRequests.length === 0 && data.unknownCommits.length === 0) {
    return <p className="text-xs text-muted-foreground">mainに未反映のPRはありません。</p>;
  }

  return (
    <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
      <p className="text-xs font-medium text-muted-foreground">
        今回反映する内容（PR {data.pullRequests.length}件
        {data.source === "release-pr" ? "・作成済みリリースPRの範囲" : ""}
        {data.headSha ? `・${data.headSha}まで` : ""}）
      </p>
      {tally && tally.total + tally.unavailable > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b pb-1.5 text-xs">
          <VerdictText kind="ok" label="問題なし" count={tally.ok} />
          <VerdictText kind="needs-check" label="要確認" count={tally.needsCheck} />
          <VerdictText kind="changes-requested" label="要修正" count={tally.changesRequested} />
          <VerdictText kind="skipped" label="レビューなし" count={tally.skipped} />
          <VerdictText kind="unknown" label="記録なし" count={tally.unknown} />
          {tally.unavailable > 0 && (
            <span className="text-destructive">取得不可 {tally.unavailable}</span>
          )}
          <span className="ml-auto text-muted-foreground">PR作成時の記録から</span>
        </div>
      )}
      <ul className="flex flex-col gap-1 text-xs">
        {data.pullRequests.map((pr) => (
          <li key={pr.number} className="flex flex-col gap-0.5 border-b pb-1.5 last:border-b-0">
            <GithubReferenceLink href={prUrl(pr.number)} className="hover:underline">
              #{pr.number} {pr.title}
              {pr.isVersionBump ? "（バージョンバンプ）" : ""}
            </GithubReferenceLink>
            {pr.issueNumber !== null && (
              <GithubReferenceLink
                href={`https://github.com/${repositoryFullName}/issues/${pr.issueNumber}`}
                className="pl-3 text-muted-foreground hover:underline"
              >
                関連Issue #{pr.issueNumber}
              </GithubReferenceLink>
            )}
            <ReleaseChangeReview pr={pr} prUrl={prUrl(pr.number)} />
          </li>
        ))}
      </ul>
      {data.unknownCommits.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t pt-1.5 text-xs text-muted-foreground">
          <p>PRとの対応を特定できないコミット（{data.unknownCommits.length}件）</p>
          <ul className="flex flex-col gap-0.5">
            {data.unknownCommits.map((commit) => (
              <li key={commit.sha}>
                {commit.sha.slice(0, 7)} {commit.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.truncated && (
        <p className="text-xs text-muted-foreground">
          コミットが多いため一部のみ表示しています。残りはGitHubで確認してください。
        </p>
      )}
    </div>
  );
}
