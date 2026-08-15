"use client";

import { DispatchJobStatus } from "@/components/dashboard/dispatch-job-status";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { findCrossRepoQuestionJobForIssue } from "@/lib/dispatch/dispatch-job";
import { describeDispatchJobWaitReason } from "@/lib/dispatch/queue-summary";
import type { Issue } from "@/types/issue";

/**
 * 横断質問セッション（#1454）を積んでから、tmuxセッションが立つまでの状態表示。
 *
 * **pull型なので、押してから起動が始まるまで最大でポーリング間隔（既定30秒）かかる**（#1180）。
 * その間に画面が何も変わらないと「押しても何も起きていない」ようにしか見えない。質問を送った
 * ダイアログはその場で閉じるため、押した結果を見る場所は開いた質問Issueのここになる。
 *
 * **`SUCCEEDED`になったら出さない。** そこから先はセッションの表示（`IssueSessionStatus`）が
 * 引き継ぐので、同じことを2つ並べない。失敗・順番待ち・取り消しは残す（押した結果が消えると
 * 「押しても何も起きなかった」と区別が付かない）。
 */
export function CrossRepoQuestionJobStatus({
  issue,
  dispatch,
  align = "end",
}: {
  issue: Pick<Issue, "repositoryFullName" | "number">;
  dispatch: DispatchStateHandle;
  align?: "start" | "end";
}) {
  const job = findCrossRepoQuestionJobForIssue(
    dispatch.jobs,
    issue.repositoryFullName,
    issue.number,
  );
  if (!job || job.status === "SUCCEEDED") return null;

  return (
    <DispatchJobStatus
      job={job}
      onCancel={() => {
        void dispatch.cancel(job.id);
      }}
      isSubmitting={dispatch.isSubmitting}
      align={align}
      // 「順番待ち」のまま進まない理由（#1394・#1544）。横断質問セッションも実装セッションと
      // 同じ枠・同じセッション本数の上限で待つので、押した本人が見ている場所に理由を出す
      waitReason={describeDispatchJobWaitReason(job, dispatch.hosts)}
    />
  );
}
