"use client";

import { useCallback, useState } from "react";

import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  findManualStepRun,
  isActiveManualStepRun,
  type ManualStepRunView,
} from "@/lib/manual-step-run-view";

/**
 * 手作業アシスタントの自動実行（#1869）を画面から操作するフック（#1882で作り替え）。
 *
 * **状態を持つのはサーバー**（`lib/manual-step-run.ts`・`ManualStepRun`）で、ここは
 * `GET /api/dispatch`が返した状態を読み、開始・中断・再開を送るだけ。
 *
 * #1869の時点では承認1回ぶんの状態を画面だけが持っており、**ダイアログを閉じれば止まる**
 * 作りだった。「自動実行中に画面を閉じたい・そのとき進行状況を確認したい」という要望（#1882）を
 * 受けて、進めるのをサーバーへ移した。おかげで**次の1件を積む制御が画面から消えている**——
 * ここに再び「次を積む」を書かないこと（サーバーと画面の2か所が積むと、同じ手順が二重に走る）。
 *
 * 対象のIssueを引数で受けるのは、同じ状態を**アシスタントの外**（実行キュー・一覧の入口）でも
 * 読むため。#1869では呼び出し側がIssueごとに作り直される前提だった。
 */
export type ManualStepAutoRunHandle = {
  /** そのIssueの自動実行。走っていなければ`null` */
  run: ManualStepRunView | null;
  /** 承認済みか（止まっている間もtrue） */
  active: boolean;
  /** いまサーバーが次の1件を流しているか */
  running: boolean;
  /** 止まっている理由。`null`なら止まっていない */
  pausedBy: ManualStepRunView["pausedReason"];
  /** 失敗したときに出力をClaudeへ送ってよいか（承認パネルのチェック） */
  consent: boolean;
  setConsent: (consent: boolean) => void;
  /** 送信中（開始・中断・再開のいずれか） */
  isSubmitting: boolean;
  /** 操作が拒否された理由。押した場所のすぐそばに出す */
  error: string | null;
  start: (hostName: string) => Promise<boolean>;
  stop: () => Promise<boolean>;
  resume: () => Promise<boolean>;
};

export function useManualStepAutoRun(params: {
  dispatch: DispatchStateHandle;
  repositoryFullName: string;
  issueNumber: number;
}): ManualStepAutoRunHandle {
  const { dispatch, repositoryFullName, issueNumber } = params;
  // 既定はオン。**押した1回にこの同意も含める**ので、外したい人は承認する前に外す
  const [consent, setConsent] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // **差し込まれた状態では欠けうる**ので、無ければ「走っていない」として読む
  const run = findManualStepRun(dispatch.manualStepRuns ?? [], repositoryFullName, issueNumber);

  const send = useCallback(
    async (action: "start" | "stop" | "resume", hostName?: string): Promise<boolean> => {
      setIsSubmitting(true);
      setError(null);
      const result = await dispatch.controlManualStepRun({
        repositoryFullName,
        issueNumber,
        action,
        hostName,
        diagnoseConsent: consent,
      });
      setIsSubmitting(false);
      if (!result.ok) {
        setError(result.message);
        return false;
      }
      return true;
    },
    [consent, dispatch, issueNumber, repositoryFullName],
  );

  const start = useCallback((hostName: string) => send("start", hostName), [send]);
  const stop = useCallback(() => send("stop"), [send]);
  /**
   * 続きから流す。**止まっていないときは送らない**——人が「実行した・次へ」を押すたびに
   * 呼ばれる口なので、走っている最中に送ると余計な往復になる。
   */
  const resume = useCallback(async () => {
    if (run === null || run.status !== "PAUSED") return false;
    return send("resume");
  }, [run, send]);

  return {
    run,
    active: run !== null && isActiveManualStepRun(run.status),
    running: run !== null && run.status === "RUNNING",
    pausedBy: run?.pausedReason ?? null,
    consent,
    setConsent,
    isSubmitting,
    error,
    start,
    stop,
    resume,
  };
}
