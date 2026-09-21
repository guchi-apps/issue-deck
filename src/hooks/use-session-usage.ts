"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ClaudeUsage } from "@/lib/claude/usage";
import type { CodexUsage } from "@/lib/dispatch/codex-usage";
import type {
  CurrentSessionUsage,
  QuotaEstimate,
  SessionUsageSummary,
} from "@/lib/session-usage-view";

export type SessionUsageResponse = SessionUsageSummary & {
  /** AIごとのプラン枠メーター。取得できなければnull */
  planUsage: { claude: ClaudeUsage | null; codex: CodexUsage | null };
  /** `CLAUDE_CODE_OAUTH_TOKEN`が未設定。エラーではないので理由を1行だけ出す */
  planNotConfigured: { claude: boolean; codex: boolean };
  /** 5時間枠の実測換算レート（#2988）。求まらなければnull */
  quotaEstimate: QuotaEstimate | null;
  /**
   * いまサブPCで生きているセッションごとの使用量（#3084）。期間には連動しない。
   * 古いサーバーの応答では無いことがあるので、画面は無ければ空として扱う
   */
  currentSessions?: CurrentSessionUsage[];
};

type UseSessionUsageResult = {
  data: SessionUsageResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
};

/** 「実行中のセッション」欄を取り直す間隔（#3135）。pollerの軽い報告と同じ20秒 */
export const CURRENT_SESSIONS_REFRESH_MS = 20_000;

/**
 * 「AI使用量」画面（#2504）のデータ取得。
 *
 * **期間の集計は自動更新しない。** 材料はサブPCのpollerが5分ごとに押し込む記録で、周期で
 * 取り直すとプラン枠の取得（`lib/claude/usage.ts`のプローブ）がそのぶん走る。更新したいときは
 * 画面の更新ボタンを押す。
 *
 * **「実行中のセッション」欄だけは20秒おきに取り直す**（#3135）。pollerが動いている転記だけを
 * 20秒おきに報告しており、`?current=1`はプラン枠を取得しない軽い経路。タブが裏にある間は
 * 取らない（戻ったらすぐ1回取る）。
 *
 * **期間を変えたときは、期間に連動しない部分（プラン枠・実行中のセッション）を取り直さず前の値を
 * 引き継ぐ**（#3257）。応答は期間の集計と同じ1本で返ってくるが、プラン枠の取得は最小の推論
 * リクエストで、期間を切り替えるたびに画面の上半分が消えて描き直されるのを避けたい。
 * 前の`data`はそのまま残すので、画面は`data.days`が選択中の期間と一致するまでを「読み込み中」と
 * 見なして期間の集計だけを隠す。プラン枠を取り直すのは初回と更新ボタンのとき。
 */
export function useSessionUsage(
  enabled: boolean,
  days: number,
): UseSessionUsageResult {
  const [data, setData] = useState<SessionUsageResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 直前の取得の期間。期間だけが変わった取得かどうかを見分ける
  const lastDaysRef = useRef<number | null>(null);

  const refresh = useCallback(() => setReloadKey((prev) => prev + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const controller = new AbortController();
    const periodChanged = lastDaysRef.current !== null && lastDaysRef.current !== days;
    lastDaysRef.current = days;

    // 画面を開いた・期間を変えた・更新を押したときにだけ走る取得で、連鎖的な再レンダリングは
    // 起きない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    // 期間だけが変わったときは前の応答を残す（プラン枠と実行中のセッションを消さない）
    if (!periodChanged) setData(null);
    setError(null);

    fetch(`/api/session-usage?days=${days}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
        return (await res.json()) as SessionUsageResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setData((prev) =>
          periodChanged && prev
            ? {
                ...json,
                planUsage: prev.planUsage,
                planNotConfigured: prev.planNotConfigured,
                quotaEstimate: prev.quotaEstimate,
                currentSessions: prev.currentSessions,
              }
            : json,
        );
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, days, reloadKey]);

  // 実行中のセッションの取り直し（#3135）。本体を取得できてから回し始める
  const hasData = data !== null;
  useEffect(() => {
    if (!enabled || !hasData) return;

    let cancelled = false;
    let controller: AbortController | null = null;

    const refreshCurrent = () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      const current = new AbortController();
      controller = current;
      fetch("/api/session-usage?current=1", { signal: current.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`取得に失敗しました (${res.status})`);
          return (await res.json()) as Pick<SessionUsageResponse, "currentSessions">;
        })
        .then((json) => {
          if (cancelled || !json.currentSessions) return;
          const currentSessions = json.currentSessions;
          setData((prev) => (prev ? { ...prev, currentSessions } : prev));
        })
        // 取り直しの失敗は黙って次の回を待つ（欄が1つ古くなるだけで、本体の表示は壊さない）
        .catch(() => {});
    };

    const timer = window.setInterval(refreshCurrent, CURRENT_SESSIONS_REFRESH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshCurrent();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, hasData]);

  return { data, isLoading, error, refresh };
}
