"use client";

import type { ReactNode } from "react";

import { GitPullRequest } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { IssueMergeButton } from "@/components/dashboard/issue-merge-button";
import {
  AiReviewBadge,
  ConflictBadge,
  MergeJudgementBadge,
  RepairRunBadge,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestCiStatusBadge } from "@/components/dashboard/pull-request-ci-status";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import {
  canMergeIssuePullRequest,
  issuePullRequestStateLabel,
  type IssuePullRequestStateLabel,
  type IssuePullRequestSummary,
  selectVisiblePullRequestLinks,
} from "@/lib/issue-pull-requests";
import { cn } from "@/lib/utils";
import type { IssuePullRequest } from "@/types/pull-request";

type IssuePullRequestListProps = {
  /** 対応PRのリンク。番号だけは詳細の取得前から分かるので、これを並びの正とする */
  links: PullRequestLink[];
  /** 取得済みの対応PRの詳細。`links`の部分集合で、取得前は空になる */
  pullRequests: IssuePullRequest[];
  /** ユーザーのマージ確認待ちか。trueのときだけマージボタンを出し、枠をハイライトする */
  mergeApprovalPending: boolean;
  /** マージを実行する。成功したらtrueを返す。省略するとマージボタンを出さない */
  onMerge?: (pullRequestNumber: number) => Promise<boolean> | boolean;
  onMerged?: (pullRequestNumber: number) => void;
  /** この画面でマージ済みにしたPR番号。GitHub側の反映を待たずに「マージ済み」を出すため */
  mergedNumbers?: ReadonlySet<number>;
  /** 直近にマージを実行したPR番号。実行中の表示とエラーの表示先を決める */
  mergeTargetNumber?: number | null;
  isMerging?: boolean;
  /** マージ失敗時のエラーメッセージ。`mergeTargetNumber`の行に出す */
  mergeError?: string | null;
  /**
   * `card`（既定）は枠と「対応PR」の見出しを付ける。Issue本文の上に単独で置くときの形。
   * `plain`は行だけを出す。コメント欄のマージ待ちカードのように、既に枠と見出しを持つ
   * 入れ物の中へ置くときに使う（枠が二重になるのを避ける）。
   */
  variant?: "card" | "plain";
  /**
   * 一覧の先頭（`card`なら見出しの下）へ差し込む案内。マージ待ちの理由（#1631）を、
   * PC・スマホのどちらでも**マージボタンと同じ枠の中**へ出すための口。枠の外へ置くと、
   * `card`では箱が2つ縦に並んで見え、どちらの操作に対する説明なのかが読み取れなくなる。
   */
  notice?: ReactNode;
  className?: string;
};

const STATE_LABEL: Record<IssuePullRequestStateLabel, string> = {
  draft: "下書き",
  open: "Open",
  merged: "マージ済み",
  closed: "クローズ",
};

const STATE_CLASS: Record<IssuePullRequestStateLabel, string> = {
  draft: "bg-muted text-muted-foreground ring-border",
  open: "bg-emerald-500/15 text-emerald-600 ring-emerald-500 dark:text-emerald-400",
  merged: "bg-violet-500/15 text-violet-600 ring-violet-500 dark:text-violet-400",
  closed: "bg-muted text-muted-foreground ring-border",
};

function IssuePullRequestStateBadge({ pullRequest }: { pullRequest: IssuePullRequest }) {
  const state = issuePullRequestStateLabel(pullRequest);
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
        STATE_CLASS[state],
      )}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

/**
 * 状態ごとの件数バッジ（例:「マージ済み 5」「Open 1」）。
 *
 * 対応PRを畳んだ行（#1577）に出して、開かなくても「どこまで進んだか」が分かるようにする。
 * 詳細が1件も取れていないときは`buckets`が空になり、何も描かない（件数はセクションの見出しが出す）。
 */
export function IssuePullRequestStateCounts({ buckets }: { buckets: IssuePullRequestSummary["buckets"] }) {
  return (
    <>
      {buckets.map((bucket) => (
        <span
          key={bucket.state}
          className={cn(
            "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
            STATE_CLASS[bucket.state],
          )}
        >
          {STATE_LABEL[bucket.state]} {bucket.count}
        </span>
      ))}
    </>
  );
}

/**
 * Issueの対応PRを一覧で表示し、マージボタンを**そのPRの行の中に**置く（#1339）。
 *
 * 1つのIssueに複数のPRがぶら下がりうるようになったため、マージボタンをIssue単位の位置
 * （画面上部の操作列・スマホのヘッダー）へ置いておくと、押したときにどのPRがマージされるのか
 * 決まらない。マージはPRに紐づく操作なので、ボタンはPRの行の中だけに置く。
 *
 * #1288が画面上部にもボタンを出していたのは「コメント欄まで下げなくても押せるように」で、
 * この一覧をIssue本文より上に置くことで同じ到達性を保っている。
 *
 * 並びの正は`links`（コメント本文・timelineから得たPR番号）で、`pullRequests`はそこへ
 * 後から合流するタイトル・状態。詳細が取れていない行でも番号とマージボタンは出す
 * （取得に失敗しただけでマージできなくなるのを避けるため）。
 */
export function IssuePullRequestList({
  links,
  pullRequests,
  mergeApprovalPending,
  onMerge,
  onMerged,
  mergedNumbers,
  mergeTargetNumber,
  isMerging,
  mergeError,
  variant = "card",
  notice,
  className,
}: IssuePullRequestListProps) {
  const detailByNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));
  const visibleLinks = selectVisiblePullRequestLinks(links, pullRequests);

  if (visibleLinks.length === 0) return null;

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-2",
        variant === "card" && "rounded-lg border p-3",
        variant === "card" && mergeApprovalPending && "border-amber-500 bg-amber-500/10",
        className,
      )}
    >
      {variant === "card" && (
        <p className="text-xs font-medium text-muted-foreground">
          対応PR{mergeApprovalPending && "・マージ待ち"}
        </p>
      )}
      {notice}
      <ul className="flex flex-col gap-2">
        {visibleLinks.map((link) => {
          const detail = detailByNumber.get(link.number);
          const merged = Boolean(mergedNumbers?.has(link.number)) || Boolean(detail?.merged);
          // 詳細が取れていない行では判断材料が無いので、マージできる前提で出す
          const canMerge = detail ? canMergeIssuePullRequest(detail) : true;
          const showMergeButton = Boolean(onMerge) && mergeApprovalPending && (canMerge || merged);

          return (
            <li key={link.number} className="flex min-w-0 flex-wrap items-center gap-2">
              <GithubReferenceLink
                href={link.url}
                // スマホでのタップ領域を確保する（旧PullRequestLinkBadgeと同じ扱い）
                className="inline-flex min-h-11 min-w-0 items-center gap-1.5 text-sm font-medium text-primary hover:underline md:min-h-0"
              >
                <GitPullRequest className="size-3.5 shrink-0" />
                <span className="shrink-0">#{link.number}</span>
                {detail && <span className="truncate font-normal">{detail.title}</span>}
              </GithubReferenceLink>
              {detail && <IssuePullRequestStateBadge pullRequest={detail} />}
              {detail && <PullRequestCiStatusBadge status={detail.ciStatus} />}
              {/* Claudeのレビューが終わったかも、PR画面と同じ部品・同じ並び順で出す（#2150） */}
              {detail && <AiReviewBadge aiReview={detail.mergeJudgement.aiReview} />}
              {/* コンフリクトと自動修復の実行中は、PR画面と同じバッジ・同じ文言で出す（#2145）。
                  CI状態だけを出していた頃は、コンフリクトしていても「CI通過」しか見えなかった */}
              {detail && <ConflictBadge mergeable={detail.mergeable} />}
              {detail && <RepairRunBadge run={detail.repairRun} compact />}
              {detail && <MergeJudgementBadge mergeJudgement={detail.mergeJudgement} />}
              {showMergeButton && onMerge && (
                <IssueMergeButton
                  className="ml-auto"
                  onMerge={() => onMerge(link.number)}
                  onMerged={() => onMerged?.(link.number)}
                  pullRequestNumber={link.number}
                  ciStatus={detail?.ciStatus ?? null}
                  mergeJudgement={detail?.mergeJudgement ?? null}
                  isMerging={Boolean(isMerging) && mergeTargetNumber === link.number}
                  isMerged={merged}
                  error={mergeTargetNumber === link.number ? mergeError : null}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
