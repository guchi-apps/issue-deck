"use client";

import type { ProgressStatusKey } from "@/lib/issue-progress";
import {
  describeProgressReportFailure,
  type ProgressReportFailureReason,
} from "@/lib/progress-report-message";

/**
 * 進捗の書き込み結果。**`setProgressStatus`は決してthrowしない**ため、
 * 失敗を知りたい呼び出し側はこの戻り値を見る。
 */
export type ProgressStatusMutationResult =
  /** APIまで届いた。`applied`がfalseなら`reason`に書かなかった理由が入る */
  | { ok: true; applied: boolean; reason: ProgressReportFailureReason | null }
  /** 非2xx・通信失敗。`message`は開発者向けの素の内容で、そのまま画面へ出さない */
  | { ok: false; message: string };

/**
 * 進捗の変更結果を画面へ出すべきエラーメッセージにする。**出す必要が無ければnull**。
 *
 * `unchanged`（既に同じStatusだった）は失敗ではないためnullになり、呼び出し側は成功と
 * 同じ扱い（選択を確定させる）で構わない。フックの外へ出しているのは、Radix Selectを
 * 開くコンポーネントテストの前例がこのリポジトリに無く、分岐だけを単体で検証するため。
 */
export function progressChangeErrorMessage(result: ProgressStatusMutationResult): string | null {
  if (!result.ok) return "進捗を変更できませんでした。時間をおいて試してください。";
  if (result.applied) return null;
  return result.reason ? describeProgressReportFailure(result.reason) : null;
}

/**
 * 画面の操作からGitHub ProjectsのStatusを動かす（#991 Phase 3）。
 *
 * **失敗を例外として伝えない。** 「実装を開始」ボタンの本体は`@claude`コメントの投稿であり、
 * Statusはカンバンを即座に追従させるための付随的な書き込みにすぎない。Project未導入の環境・
 * Projectへ未登録のIssue・一時的な通信失敗のいずれでも、ボタンは従来どおり動く必要がある。
 * 取りこぼしたStatusは、直後にワークフローが進捗報告APIへ送る値か、再同期で追いつく。
 *
 * **一方、右パネルの進捗セレクト（#1350）のようにStatusの変更そのものが目的の操作では、
 * 黙って失敗すると「選んだのに戻る」だけになる。** そのため結果を戻り値として返し、
 * 出すかどうかは呼び出し側に委ねる（例外にしないという上の契約はそのまま）。
 */
export function useProgressStatusMutation() {
  async function setProgressStatus(params: {
    repositoryFullName: string;
    number: number;
    status: ProgressStatusKey;
  }): Promise<ProgressStatusMutationResult> {
    try {
      const res = await fetch("/api/issues/progress-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repository: params.repositoryFullName,
          issue: params.number,
          status: params.status,
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        return { ok: false, message: data.error ?? `request_failed_${res.status}` };
      }
      const data: { applied?: boolean; reason?: ProgressReportFailureReason } = await res
        .json()
        .catch(() => ({}));
      return { ok: true, applied: data.applied === true, reason: data.reason ?? null };
    } catch (error) {
      console.error("[useProgressStatusMutation] failed to set project status", error);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  return { setProgressStatus };
}
