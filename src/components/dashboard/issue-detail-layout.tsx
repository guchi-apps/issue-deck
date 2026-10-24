"use client";

import type { ComponentProps, ReactNode } from "react";

import { IssueDetailSection } from "@/components/dashboard/issue-detail-section";
import {
  IssuePullRequestList,
  IssuePullRequestStateCounts,
} from "@/components/dashboard/issue-pull-request-list";
import { MergeCheckReasonNotice } from "@/components/dashboard/merge-check-reason-notice";
import { SubIssueProgress } from "@/components/dashboard/sub-issue-progress";
import { Separator } from "@/components/ui/separator";
import { checkUserTargetProps } from "@/lib/check-user-focus";
import type { IssuePullRequestSummary } from "@/lib/issue-pull-requests";
import type { MergeCheckReasons } from "@/lib/merge-check-reasons";
import type { SubIssueProgressSummary } from "@/lib/sub-issue-progress";

type IssueDetailLayoutProps = {
  /** 正式タイトル（全文）。PCは本文先頭のタイトル、スマホは概要カード */
  title: ReactNode;
  /** 現在状態と主操作（代表状態・状態カード・停滞の復旧・手作業・開始ボタンなど） */
  status: ReactNode;
  /** 判断材料（質問・成果物・計画・計画レビュー・コードレビュー・実施順序） */
  decision: ReactNode;
  /** 判断材料の後ろに置く補足（スマホのプロパティ折りたたみ）。PCは右列・シートにあるので渡さない */
  supplement?: ReactNode;
  /** 概要（説明） */
  overview: ReactNode;
  /** 関連（子Issue・承認後の成果物）。対応PRは`pullRequests`で別に渡す */
  related: ReactNode;
  /** 対応PRのセクション。置き場所は`promotePullRequests`で決まる */
  pullRequests: ReactNode;
  /**
   * 対応PRを判断材料の末尾へ上げるか。マージ待ち・PR失敗のときだけ真にする。
   *
   * 昇格しないときも、対応PRはプロパティ（補足）の下・説明の上に置く（#4959）。
   *
   * 以前は対応PRを常に説明より上へ置いていた（マージボタンをコメント欄まで下げずに押せる位置を
   * 保つ #1288・#1339）。並びを「判断材料→概要／活動／関連PR」へ揃えた（#4440）あとも、
   * **PRを見る必要があるときだけ**判断材料の位置に出して、その意図を保つ。
   */
  promotePullRequests: boolean;
  /** 活動（コメント・入力欄） */
  activity: ReactNode;
};

/**
 * Issue詳細の並び順の正（#4425・#4440）。PC（`IssueDetail`）とスマホ（`MobileIssueDetail`）が
 * 同じ順で描くよう、並びはここにだけ書く。
 *
 * 短い固定ヘッダー（各画面が持つ）→ 正式タイトル → 状態と主操作 → 判断材料 →（補足）→
 * 対応PR → 概要 → 関連 → 活動。
 *
 * **外枠は持たない**（Fragmentを返す）。スクロール領域の`ref`・`flex-1`・下端の余白は画面ごとに
 * 事情が違い（#1664・#1793）、ここで包むとその規約を壊す。
 */
export function IssueDetailLayout({
  title,
  status,
  decision,
  supplement,
  overview,
  related,
  pullRequests,
  promotePullRequests,
  activity,
}: IssueDetailLayoutProps) {
  return (
    <>
      {title}
      {status}
      {decision}
      {promotePullRequests && pullRequests}
      {supplement}
      {!promotePullRequests && pullRequests}

      <Separator />

      {overview}
      {related}

      <Separator />

      {activity}
    </>
  );
}

/**
 * 対応PRのセクション（PC・スマホ共通）。既定では畳み、マージ待ち・PR失敗のときだけ開いたままにする
 * （#1577）。PRのマージ・クローズはPR詳細の操作なので、ここには置かない（#3333）。
 */
export function IssuePullRequestsSection({
  summary,
  mergeApprovalPending,
  hasFailingPullRequest,
  mergeCheckReasons,
  links,
  pullRequests,
}: {
  summary: IssuePullRequestSummary;
  mergeApprovalPending: boolean;
  hasFailingPullRequest: boolean;
  mergeCheckReasons: MergeCheckReasons;
  links: ComponentProps<typeof IssuePullRequestList>["links"];
  pullRequests: ComponentProps<typeof IssuePullRequestList>["pullRequests"];
}) {
  return (
    <IssueDetailSection
      id="pull-requests"
      /* 上部の案内から「対応PRへ移動」で飛んでくる先（#1663） */
      targetProps={checkUserTargetProps("pull-requests")}
      title={mergeApprovalPending ? "対応PR・マージ待ち" : "対応PR"}
      count={summary.total}
      forceOpen={mergeApprovalPending || hasFailingPullRequest}
      tone={hasFailingPullRequest ? "danger" : mergeApprovalPending ? "attention" : "default"}
      summary={<IssuePullRequestStateCounts buckets={summary.buckets} />}
    >
      <IssuePullRequestList
        variant="plain"
        /* なぜ自動マージされず自分の操作が要るのかを、PR詳細への導線と同じ枠の中に
           出す（#1631）。理由はコメントの奥にしかなく、押す場所から離れていた */
        notice={
          mergeApprovalPending ? <MergeCheckReasonNotice reasons={mergeCheckReasons} /> : undefined
        }
        links={links}
        pullRequests={pullRequests}
        mergeApprovalPending={mergeApprovalPending}
      />
    </IssueDetailSection>
  );
}

/**
 * 子Issue・親Issueのセクション（PC・スマホ共通）。畳んでいても完了率は行に残す（#1340・#1646）
 */
export function IssueSubIssuesSection({
  relations,
  summary,
  baseRepositoryFullName,
}: {
  relations: ComponentProps<typeof SubIssueProgress>["relations"];
  summary: SubIssueProgressSummary;
  baseRepositoryFullName: string;
}) {
  return (
    <IssueDetailSection
      id="sub-issues"
      title={relations.children.length > 0 ? "子Issue" : "親Issue"}
      count={relations.childCount}
      summary={
        relations.children.length > 0 ? (
          <>
            <span
              className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={summary.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="子Issueの完了率"
            >
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${summary.percent}%` }}
              />
            </span>
            <span className="text-xs text-muted-foreground">
              {summary.done} / {summary.total} 完了
            </span>
          </>
        ) : (
          <span className="truncate text-xs text-muted-foreground">
            #{relations.parent?.number} {relations.parent?.title}
          </span>
        )
      }
    >
      <SubIssueProgress
        relations={relations}
        baseRepositoryFullName={baseRepositoryFullName}
        showHeading={false}
      />
    </IssueDetailSection>
  );
}
