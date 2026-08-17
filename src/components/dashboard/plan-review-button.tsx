"use client";

import { Loader2, ScanSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobStatus,
  describePlanReviewRejection,
  findPlanReviewJobForIssue,
  isActiveDispatchJobStatus,
  resolveDefaultPlanReviewHost,
  resolvePlanReviewRejection,
} from "@/lib/dispatch/dispatch-job";
import { parseRepositoryFullName } from "@/lib/local-session";
import type { Issue } from "@/types/issue";

/**
 * 計画の関門（G1・#1218）を人が起こす導線（#1855）。
 *
 * **主経路は自動起動**（計画コメントの投稿を契機に`postSessionPlan`が積む）で、ここは
 * その取りこぼしを拾うためのボタン。押したくなるのは次の3つ。
 *
 * - 自動で積まれなかった（計画を出した時点でサブPCが落ちていた・pollerが古かった）
 * - 指摘を受けて計画を直したので、直した計画にもう一度かけたい
 * - `21.plan-required`を後から付けた（自動起動はラベルが付いている計画だけを対象にする）
 *
 * **押せない理由は押す前に出し、ボタンごと消さない**（#1180・#1332と同じ立場）。導線ごと
 * 消すと、なぜレビューを起こせないのかが画面から分からなくなる。
 */
export function PlanReviewButton({
  issue,
  dispatch,
}: {
  issue: Issue;
  /** 画面で1回だけ取ったディスパッチの状態（#1262） */
  dispatch: DispatchStateHandle;
}) {
  const job = findPlanReviewJobForIssue(dispatch.jobs, issue.repositoryFullName, issue.number);
  const hasActiveJob = job !== null && isActiveDispatchJobStatus(job.status);

  // 起動先は「計画レビューを実行できると申告しているホスト」から選ぶ。**GitHub Actionsへの
  // フォールバックは無い**（無人実行のG1は計画提示の直後にActions自身が走らせるもので、
  // こちらから積む相手ではない）
  const hostName = resolveDefaultPlanReviewHost(dispatch.hosts, issue.repositoryFullName);
  // **理由を出すために見るホストと、積む先のホストは分けて考える。** 選べるホストが1台も無い
  // ときに`null`のまま判定へ渡すと、pollerが未対応でもcloneが無くても
  // 「申告がまだ届いていません」になり、何をすれば押せるようになるかが分からなくなる。
  // 申告が1つでも届いているなら、そのホストに対する具体的な理由を出す
  const judgedHost =
    (hostName ? dispatch.hosts.find((candidate) => candidate.name === hostName) : null) ??
    dispatch.hosts[0] ??
    null;
  const rejection = resolvePlanReviewRejection({
    host: judgedHost,
    repositoryFullName: issue.repositoryFullName,
    hasActiveJob,
  });

  if (parseRepositoryFullName(issue.repositoryFullName) === null) return null;

  const rejectionMessage = rejection
    ? describePlanReviewRejection(rejection, {
        // 名指しする相手は判定に使ったホスト。1台も申告が無ければ既定の起動先の呼び名を出す
        hostName: judgedHost?.name ?? "subpc",
        repositoryFullName: issue.repositoryFullName,
      })
    : null;

  return (
    <div className="mt-2 flex w-full flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="w-full sm:w-auto"
        disabled={dispatch.isSubmitting || rejection !== null || hostName === null}
        onClick={() => {
          if (!hostName) return;
          void dispatch.enqueue({
            repositoryFullName: issue.repositoryFullName,
            issueNumber: issue.number,
            hostName,
            kind: "plan_review",
          });
        }}
      >
        {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <ScanSearch />}
        計画をレビュー
      </Button>
      {/* 積んだ後は状態を出す。**pull型で最大1分ほど何も起きない**ので、黙っていると
          押せていないように見える（#1332と同じ理由） */}
      {job && (
        <p className="w-full break-words text-right text-xs text-muted-foreground">
          {describeDispatchJobStatus(job.status, job.kind).label}
          {job.message ? `（${job.message}）` : ""}
        </p>
      )}
      {/* 未処理のジョブがある場合は、上の状態表示が同じことを言うので理由は出さない */}
      {rejectionMessage && rejection !== "already_queued" && (
        <p className="w-full break-words text-right text-xs text-muted-foreground">
          {rejectionMessage}
        </p>
      )}
    </div>
  );
}
