"use client";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { VerdictText } from "@/components/dashboard/review-verdict";
import { useReleaseChanges } from "@/hooks/use-release-changes";
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
 * そのPR1本ぶんの自動レビュー判定（#4245・#5163）。一覧で「どのPRが入るか」を一目で追えるよう、
 * 判定ラベルだけを1行に出す。機械的リスクの理由・判定時コミットの注記は出さず、PRで確認する。
 * バンプPRはレビューの対象ではないので出さない。
 */
function ReleaseChangeReview({ pr }: { pr: ReleaseChangePullRequest }) {
  if (pr.isVersionBump) return null;
  if (pr.reviewUnavailable) {
    return <span className="text-destructive">取得不可</span>;
  }
  const { review } = pr;
  if (review === null) {
    return <VerdictText kind="unknown" label="記録なし" />;
  }
  return <VerdictText kind={review.reviewKind} label={review.reviewLabel} />;
}

/**
 * リリース起動確認の「今回反映する内容」（PR単位。#4201）。PC・スマホで共通。
 *
 * 取得中・取得失敗・変更0件・PRに対応づかないコミットを区別して出す。失敗を0件として
 * 見せないのが要点で、「出す変更がありません」と誤認したまま起動させない。
 */
function ReleaseChangeListContent({
  repositoryFullName,
  enabled,
  releasePullRequestNumber = null,
}: ReleaseChangeListProps) {
  const { data, isLoading, error } = useReleaseChanges(
    repositoryFullName,
    enabled,
    releasePullRequestNumber,
  );
  const visiblePullRequests = data?.pullRequests.filter((pr) => !pr.isVersionBump) ?? [];
  const tally = data ? tallyReleaseReviews(visiblePullRequests) : null;
  const prUrl = (number: number) => `https://github.com/${repositoryFullName}/pull/${number}`;

  if (error) {
    return (
      <p className="text-xs text-destructive">
        今回反映する内容を取得できませんでした（{error}）。変更0件ではありません。GitHubで差分を確認してください。
      </p>
    );
  }
  if (isLoading || !data) {
    return (
      <div role="status" aria-label="今回反映する内容を取得中" className="flex flex-col gap-3">
        <span className="sr-only">今回反映する内容を取得中...</span>
        <div aria-hidden="true" className="flex flex-col gap-3 motion-safe:animate-pulse">
          <div className="h-3 w-3/4 rounded bg-muted" />
          {[0, 1].map((row) => (
            <div key={row} className="flex flex-col gap-2 border-t pt-3">
              <div className="h-3 w-full rounded bg-muted" />
              <div className="h-3 w-1/2 rounded bg-muted" />
              <div className="h-3 w-4/5 rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (visiblePullRequests.length === 0 && data.unknownCommits.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {data.pullRequests.length > 0
          ? "今回表示する通常PRはありません（バージョンバンプPRは非表示）。"
          : "mainに未反映のPRはありません。"}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        今回反映する内容（PR {visiblePullRequests.length}件
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
        {visiblePullRequests.map((pr) => (
          <li
            key={pr.number}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b pb-1.5 last:border-b-0"
          >
            <GithubReferenceLink
              href={prUrl(pr.number)}
              className="min-w-0 flex-1 basis-full hover:underline sm:basis-0 sm:truncate"
              title={pr.title}
            >
              #{pr.number} {pr.title}
            </GithubReferenceLink>
            <ReleaseChangeReview pr={pr} />
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

/** 読み込み前後で高さを揃え、一覧の取得で確認ボタンが移動するのを防ぐ。 */
export function ReleaseChangeList(props: ReleaseChangeListProps) {
  return (
    <section
      aria-label="今回反映する内容"
      tabIndex={0}
      className="h-[min(16rem,28dvh)] shrink-0 overflow-y-auto rounded-md border p-2"
    >
      <ReleaseChangeListContent {...props} />
    </section>
  );
}
