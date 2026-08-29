"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  isPropagationRunning,
  type PropagationRun,
  type SourceAhead,
  type WorkflowTagStatus,
} from "@/lib/workflow-tags";

type Overview = {
  latest: string | null;
  repositories: WorkflowTagStatus[];
  propagation: PropagationRun | null;
  /** 不足しているcallerの配布（#1948・#1475）。タグ配布とは別のrun */
  repairPropagation: PropagationRun | null;
  /** ワークフロー以外の配布物の更新（#2240）。これも別のrun */
  sharedFilePropagation: PropagationRun | null;
  /** 配布元（`main`）が最新タグからどれだけ進んでいるか（#2476）。取れなければ null */
  sourceAhead: SourceAhead | null;
};

/** 配布ワークフローが動いている間の再取得間隔。PRの作成は1リポジトリあたり数秒〜数十秒 */
const RUNNING_POLL_INTERVAL_MS = 10_000;

/**
 * 起動してからrunが見えるようになるまで「実行中」として扱う上限。
 *
 * `workflow_dispatch`はrunを作る前に返るため、直後の取得ではまだ何も見えない。**その隙に
 * ボタンが再び押せると二重に起動できてしまう**ので、見えるまでのあいだも実行中として扱う。
 * 起動に成功したのにrunが現れない場合（GitHub側の遅延など）に押せないままにならないよう、
 * 上限を置く。
 */
const AWAITING_RUN_TIMEOUT_MS = 90_000;

/**
 * 共有ワークフローの参照タグの状況を取得する（#985）。
 *
 * **リポジトリ数ぶんのGitHub API呼び出しになるため、`enabled`が真になったときと、明示的な
 * 再取得のときだけ動かす。** 例外は配布ワークフローが動いている間で、そのときだけ
 * ポーリングする（#1602）。押してからPRが出来上がるまで数分あり、その間の状態が見えないと
 * 「押しても何も起きていない」ようにしか見えず、続けて押してしまう
 * （`use-secrets-sync.ts`と同じ理由・同じ形）。
 */
export function useWorkflowTags(enabled: boolean) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 明示的な再取得のたびに増やして、下のeffectを再実行させる
  const [reloadCount, setReloadCount] = useState(0);
  // 起動したがまだrunが見えていない状態。真のあいだは実行中として扱う
  const [awaiting, setAwaiting] = useState(false);
  const awaitingSince = useRef<number | null>(null);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  /** 起動に成功した直後に呼ぶ。runが見えるまでのあいだも実行中として扱わせる */
  const markDispatched = useCallback(() => {
    awaitingSince.current = Date.now();
    setAwaiting(true);
    setReloadCount((count) => count + 1);
  }, []);

  // **どちらかの配布が動いていれば「実行中」として扱う。** 押せる操作はどちらも
  // 同じリポジトリ群の`.github/workflows/`へPRを作るもので、重ねて起こすと画面から
  // 何が進行中なのか読めなくなる（#1948）。
  const isTagRunning = isPropagationRunning(overview?.propagation ?? null);
  const isRepairRunning = isPropagationRunning(overview?.repairPropagation ?? null);
  const isSharedFileRunning = isPropagationRunning(overview?.sharedFilePropagation ?? null);
  const isRunning = isTagRunning || isRepairRunning || isSharedFileRunning || awaiting;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/workflow-tags");
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        const json = (await res.json()) as Overview;
        if (cancelled) return;

        setOverview(json);
        setError(null);

        // runが見えた（または待ちすぎた）ら、以降は取得結果だけで実行中かを判断する
        const since = awaitingSince.current;
        if (
          since !== null &&
          (isPropagationRunning(json.propagation) ||
            isPropagationRunning(json.repairPropagation) ||
            isPropagationRunning(json.sharedFilePropagation) ||
            Date.now() - since > AWAITING_RUN_TIMEOUT_MS)
        ) {
          awaitingSince.current = null;
          setAwaiting(false);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    // ダイアログを開いたタイミングでの一度きりの取得と、実行中のポーリング。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    void load();

    if (!isRunning) {
      return () => {
        cancelled = true;
      };
    }

    const timer = setInterval(() => void load(), RUNNING_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, reloadCount, isRunning]);

  return {
    overview,
    isLoading,
    error,
    isRunning,
    isRepairRunning,
    isSharedFileRunning,
    reload,
    markDispatched,
  };
}
