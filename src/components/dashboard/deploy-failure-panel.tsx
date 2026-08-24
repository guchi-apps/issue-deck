"use client";

import { DeployFailureAlert } from "@/components/dashboard/deploy-failure-alert";
import { formatDateTimeFull } from "@/lib/format-date-time";
import type { DeployFailureMeta } from "@/lib/deploy-failure";

/**
 * 自動起票したデプロイ失敗Issueの詳細に出すパネル（#2236）。
 *
 * **本文を読ませる前に、直す手段を出す。** このIssueを開いた人がやることは、たいてい
 * 「もう一度流す」の1つしかない。手作業Issueのパネル（#1280）が「やること」の上に出口を
 * 置いているのと同じ考え方で、説明より上に置く。
 *
 * **材料はIssue本文に埋めた不可視マーカーから読む**（`parseDeployFailureMeta`）。Issueの本文は
 * issue-deckのDBへ同期済みなので、パネルを出すのに追加のAPI呼び出しが要らない。
 * マーカーが無い・壊れているIssueでは、呼び出し側が`meta`をnullで受け取りパネルを出さない。
 */
export function DeployFailurePanel({ meta }: { meta: DeployFailureMeta }) {
  return (
    <DeployFailureAlert
      repositoryFullName={meta.repositoryFullName}
      title="本番デプロイが失敗しています"
      version={meta.version}
      previousVersion={meta.previousVersion}
      autoRetried={meta.attempt > 1}
      failedJobs={meta.failedJobs}
      runUrl={meta.runUrl}
      footer={
        <>
          {meta.detectedAt && <>検知: {formatDateTimeFull(meta.detectedAt)}。</>}
          押し直しても直らない場合は、コードの修正が必要です（このIssueからそのまま実装を開始できます）。
          次のデプロイが成功すると、このIssueは自動でクローズされます。
        </>
      }
    />
  );
}
