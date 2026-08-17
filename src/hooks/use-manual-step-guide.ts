"use client";

import { useCallback, useState } from "react";

import type { ManualStepReadinessMap } from "@/lib/manual-step-attention";
import { buildManualStepQueue } from "@/lib/manual-step-guide";
import type { Issue } from "@/types/issue";

/**
 * 手作業アシスタント（#1826）の開閉と、案内するIssueの並びを持つ。
 *
 * **並びは開いた時点で確定させる**（スナップショット）。案内の途中で手作業をクローズすると
 * 一覧から外れるため、毎レンダー並びを作り直すと「N件中2件目」の分母が進むたびに減り、
 * どこまで進んだのかを画面から読めなくなる。
 *
 * ダイアログは`IssueDeckShell`に1つだけ置き、PC・スマホのどちらの入口からもこの状態を使う。
 */
export function useManualStepGuide(issues: Issue[], readiness: ManualStepReadinessMap) {
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  /**
   * @param startIssueId Issue詳細から開いた場合の起点。渡すとそのIssueが先頭になる
   *   （前提待ちでも外さない。`buildManualStepQueue`を参照）
   */
  const start = useCallback(
    (startIssueId?: string) => {
      const queue = buildManualStepQueue(issues, readiness, startIssueId);
      setQueueIds(queue.map((issue) => issue.id));
      setOpen(true);
    },
    [issues, readiness],
  );

  return { open, setOpen, queueIds, start };
}
