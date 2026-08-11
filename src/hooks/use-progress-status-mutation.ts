"use client";

import type { ProgressStatusKey } from "@/lib/issue-progress";

/**
 * 画面の操作からGitHub ProjectsのStatusを動かす（#991 Phase 3）。
 *
 * **失敗を呼び出し側へ伝えない。** 「実装を開始」ボタンの本体は`@claude`コメントの投稿であり、
 * Statusはカンバンを即座に追従させるための付随的な書き込みにすぎない。Project未導入の環境・
 * Projectへ未登録のIssue・一時的な通信失敗のいずれでも、ボタンは従来どおり動く必要がある。
 * 取りこぼしたStatusは、直後にワークフローが進捗報告APIへ送る値か、再同期で追いつく。
 */
export function useProgressStatusMutation() {
  async function setProgressStatus(params: {
    repositoryFullName: string;
    number: number;
    status: ProgressStatusKey;
  }): Promise<void> {
    try {
      await fetch("/api/issues/progress-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repository: params.repositoryFullName,
          issue: params.number,
          status: params.status,
        }),
      });
    } catch (error) {
      console.error("[useProgressStatusMutation] failed to set project status", error);
    }
  }

  return { setProgressStatus };
}
