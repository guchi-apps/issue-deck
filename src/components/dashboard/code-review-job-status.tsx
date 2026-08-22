"use client";

import { DispatchJobStatus } from "@/components/dashboard/dispatch-job-status";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { findCodeReviewJobForIssue } from "@/lib/dispatch/dispatch-job";
import { describeDispatchJobWaitReason } from "@/lib/dispatch/queue-summary";
import type { Issue } from "@/types/issue";

/**
 * コードレビュー（#698）を積んでから、レビューのセッションが立つまでの状態表示。
 *
 * **`CrossRepoQuestionJobStatus`と同じ立場。** pull型なので押してから起動まで最大でポーリング
 * 間隔（既定30秒）かかり、その間に画面が変わらないと「押しても何も起きていない」ように見える。
 * 実行ダイアログはその場で閉じるので、押した結果を見る場所は開いたレビューIssueのここになる。
 *
 * **`SUCCEEDED`になったら出さない。** そこから先は結果の待ち（`CodeReviewPanel`の「レビュー中」）
 * が引き継ぐ。失敗・見送り・順番待ち・取り消しは残す——ここを消すと、起動できなかったレビューが
 * 「レビュー中」のまま永久に待っているように見える。
 */
export function CodeReviewJobStatus({
  issue,
  dispatch,
  align = "end",
}: {
  issue: Pick<Issue, "repositoryFullName" | "number">;
  dispatch: DispatchStateHandle;
  align?: "start" | "end";
}) {
  const job = findCodeReviewJobForIssue(dispatch.jobs, issue.repositoryFullName, issue.number);
  if (!job || job.status === "SUCCEEDED") return null;

  return (
    <DispatchJobStatus
      job={job}
      onCancel={() => {
        void dispatch.cancel(job.id);
      }}
      isSubmitting={dispatch.isSubmitting}
      align={align}
      // 「順番待ち」のまま進まない理由（#1394・#1544）。レビューのセッションも実装セッションと
      // 同じ枠で待つので、押した本人が見ている場所に理由を出す
      waitReason={describeDispatchJobWaitReason(job, dispatch.hosts)}
    />
  );
}
