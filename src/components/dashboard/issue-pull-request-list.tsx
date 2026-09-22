"use client";

import type { ReactNode } from "react";

import { ArrowRight, GitPullRequest } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import {
  AiReviewBadge,
  ConflictBadge,
  MergeJudgementBadge,
  RepairRunBadge,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestCiStatusBadge } from "@/components/dashboard/pull-request-ci-status";
import {
  PullRequestProgressLabel,
  PullRequestProgressStepList,
} from "@/components/dashboard/pull-request-progress-steps";
import { Button } from "@/components/ui/button";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import {
  buildIssuePullRequestProgress,
  toIssuePullRequestProgressSource,
} from "@/lib/issue-pull-request-progress";
import {
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
  /**
   * ユーザーのマージ確認待ちか。trueのときは枠をハイライトし、各行の導線を
   * 「PR詳細でマージ・修正依頼」の塗りボタンにする（#3333）
   */
  mergeApprovalPending: boolean;
  /**
   * `card`（既定）は枠と「対応PR」の見出しを付ける。Issue本文の上に単独で置くときの形。
   * `plain`は行だけを出す。既に枠と見出しを持つ入れ物の中へ置くときに使う（枠が二重になるのを避ける）。
   */
  variant?: "card" | "plain";
  /**
   * 一覧の先頭（`card`なら見出しの下）へ差し込む案内。マージ待ちの理由（#1631）を、
   * PC・スマホのどちらでも**PR詳細への導線と同じ枠の中**へ出すための口。
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

const ROLE_LABEL: Record<NonNullable<IssuePullRequest["role"]>, string> = {
  closing: "最終PR",
  interim: "途中PR",
};

/**
 * 「このIssueを閉じるPRか、途中PRか」のバッジ（#3334）。developへのマージではissueを
 * 自動クローズしない運用のため、GitHubの`closes`/`fixes`の代わりにPR本文のマーカー
 * （`lib/github/pull-request-role.ts`）から読む。1 Issueに複数PRがぶら下がる場合に、
 * どれが最終PRかを一覧から読めるようにする。マーカーが無いPR（導入前のPR等）では出さない。
 */
function IssuePullRequestRoleBadge({ role }: { role: NonNullable<IssuePullRequest["role"]> }) {
  return (
    <span className="inline-flex w-fit items-center rounded-full bg-sky-500/15 px-2.5 py-1 text-xs font-medium text-sky-600 ring-1 ring-inset ring-sky-500 dark:text-sky-400">
      {ROLE_LABEL[role]}
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
 * Issueの対応PRを一覧で表示する。**PRを変更する操作は置かない**（#3333）。
 *
 * 以前（#1288・#1339・#2780）はこの行に「マージする」「マージしない」を置き、Issue詳細からも
 * PRをマージ・クローズできた。PR詳細にも同じ操作があり、確認ダイアログと判定（`mergeWarnings`・
 * 本番マージ判定など）が2系統に割れて、どちらから押すかで確かめる内容が変わりえた。
 * **Issue詳細は「何を完了させるか」、PR詳細は「変更をどう統合するか」**に分け、ここは
 * 状態の要約（状態・CI・レビュー・コンフリクト・判定）と、アプリ内のPR詳細を開く導線だけを持つ。
 *
 * 並びの正は`links`（コメント本文・timelineから得たPR番号）で、`pullRequests`はそこへ
 * 後から合流するタイトル・状態。詳細が取れていない行でも番号とPR詳細への導線は出す。
 */
export function IssuePullRequestList({
  links,
  pullRequests,
  mergeApprovalPending,
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
          const open = detail ? detail.state === "open" && !detail.merged : true;
          // 開いていて下書きでないPRだけ、Issue詳細の上部と同じ内訳を出す（#3239）。マージ済み・
          // クローズ・下書きは待っているものが無い（または材料が取れていない）ので、従来の
          // 状態バッジのまま
          const progress =
            detail && detail.state === "open" && !detail.draft && !detail.merged
              ? buildIssuePullRequestProgress(toIssuePullRequestProgressSource(detail))
              : null;
          // マージを待っているのは開いているPRだけ。閉じた行まで塗りボタンにすると、
          // どれを見に行けばよいのかが読み取れなくなる
          const emphasize = mergeApprovalPending && open;

          return (
            <li key={link.number} className="flex min-w-0 flex-wrap items-center gap-2">
              <GithubReferenceLink
                href={link.url}
                // スマホでのタップ領域を確保する（旧PullRequestLinkBadgeと同じ扱い）
                className={cn(
                  "inline-flex min-h-11 min-w-0 items-center gap-1.5 text-sm font-medium text-primary hover:underline md:min-h-0",
                  // 内訳のある行は、タイトルを1行使い、状態・待っているもの・導線を次の行へ送る
                  progress && "w-full",
                )}
              >
                <GitPullRequest className="size-3.5 shrink-0" />
                <span className="shrink-0">#{link.number}</span>
                {detail && <span className="truncate font-normal">{detail.title}</span>}
              </GithubReferenceLink>
              {detail && <IssuePullRequestStateBadge pullRequest={detail} />}
              {detail?.role && <IssuePullRequestRoleBadge role={detail.role} />}
              {detail && progress && <PullRequestProgressLabel progress={progress} />}
              {/* 内訳を出さない行（マージ済み・クローズ・下書き）は、従来どおりバッジで言う。
                  CI・レビュー・コンフリクト・判定は内訳の工程に入っているので、内訳がある行では出さない */}
              {detail && !progress && <PullRequestCiStatusBadge status={detail.ciStatus} />}
              {detail && !progress && <AiReviewBadge aiReview={detail.mergeJudgement.aiReview} />}
              {detail && !progress && <ConflictBadge mergeable={detail.mergeable} />}
              {/* 自動修復の実行中は、PR画面と同じバッジ・同じ文言で出す（#2145）。経過時間を数え直す
                  生きたバッジなので、内訳の工程には入れずここに残す */}
              {detail && <RepairRunBadge run={detail.repairRun} compact />}
              {detail && !progress && <MergeJudgementBadge mergeJudgement={detail.mergeJudgement} />}
              {/* マージ・クローズ・修正依頼・コンフリクト解消はPR詳細が持つ（#3333）。
                  タイトルのリンクと行き先は同じだが、「ここで操作はできない、あちらで行う」ことを
                  ボタンの形で言う。マージ待ちの行はスマホで押し損ねないよう幅いっぱいにする */}
              <Button
                asChild
                size="sm"
                variant={emphasize ? "default" : "outline"}
                className={cn("ml-auto", emphasize && "max-md:min-h-10 max-md:w-full")}
              >
                <GithubReferenceLink href={link.url}>
                  {emphasize ? "PR詳細でマージ・修正依頼" : "PR詳細で操作"}
                  <ArrowRight />
                </GithubReferenceLink>
              </Button>
              {progress && (
                <PullRequestProgressStepList
                  className="w-full"
                  progress={progress}
                  reviewRunUrl={
                    detail?.mergeJudgement.aiReview.runUrl ?? detail?.mergeJudgement.runUrl ?? null
                  }
                />
              )}
            </li>
          );
        })}
      </ul>
      {mergeApprovalPending && (
        <p className="text-xs text-muted-foreground">マージ・クローズ・修正依頼はPR詳細で行います。</p>
      )}
    </div>
  );
}
