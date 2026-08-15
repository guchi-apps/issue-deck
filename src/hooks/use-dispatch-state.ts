"use client";

import { useCallback, useEffect, useState } from "react";

import {
  isActiveDispatchJobStatus,
  type DispatchHostView,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

/**
 * サブPCへのディスパッチ（#1179）の状態を画面から見るためのフック（#1180）。
 *
 * `GET /api/dispatch`が返すのは「ホストの申告・未完了ジョブ・直近24時間の終了ジョブ・
 * 同時実行数」の一式で、起動先を選ばせる判断（応答しているか・そのリポジトリを実行できるか）と、
 * 積んだ後の状態表示の両方がこれ1本で足りる。
 *
 * **pull型なので、押してから起動が始まるまでに最大でポーリング間隔（既定60秒）かかる。**
 * その間に画面が何も変わらないと「押しても何も起きていない」ように見えるため、未完了ジョブが
 * ある間は短い間隔で取り直す。
 */

export type DispatchState = {
  hosts: DispatchHostView[];
  jobs: DispatchJobView[];
  /**
   * 起動後のtmuxセッション（#1217）。APIは以前から返していたが画面へ出していなかった。
   * Issueの実行先の解決（#1262・`resolveIssueExecutionTarget`）がこれを使う。
   */
  sessions: DispatchSessionView[];
  concurrency: number;
};

/** 未完了ジョブがある間の取得間隔。押した直後の状態変化を追う */
const ACTIVE_POLL_INTERVAL_MS = 5_000;
/**
 * 何も動いていないときの取得間隔。
 *
 * **GitHub Actionsの実行状況ポーリング（`use-issues-workflow-running.ts`）と同じ20秒に
 * 揃えている**（#1439）。一覧のバッジの回転はActions側がこのフック、サブPC側がこちらの
 * セッションを材料にするため、間隔が違うと同じ「実行中」でも実行先によって反映の速さが変わる。
 * 叩き先は自前の`GET /api/dispatch`（DBの読み取りのみ）で、GitHub APIは消費しない。
 */
const IDLE_POLL_INTERVAL_MS = 20_000;

function hasActiveJob(state: DispatchState | null): boolean {
  return state?.jobs.some((job) => isActiveDispatchJobStatus(job.status)) ?? false;
}

async function readErrorMessage(res: Response): Promise<string> {
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  // APIは拒否理由を利用者向けの文言で返す（#1179）。そのまま出すのが最も情報量が多い
  return json.message ?? `リクエストに失敗しました (${res.status})`;
}

/**
 * `useDispatchState`の戻り値。**同じ画面で複数のコンポーネントが必要とする場合は、
 * 親で1回だけ呼んでこの型で配る**（#1262）。取得口を増やすと同じ画面のためにポーリングが
 * 何本も走る。
 */
export type DispatchStateHandle = ReturnType<typeof useDispatchState>;

export function useDispatchState(enabled: boolean) {
  const [state, setState] = useState<DispatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // enqueue・cancelの直後に取り直すためのキー。増やすと下のeffectが再実行される
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let latest: DispatchState | null = null;

    async function load() {
      inFlight = true;
      try {
        const res = await fetch("/api/dispatch");
        if (!res.ok) return;
        const json = (await res.json()) as DispatchState;
        if (cancelled) return;
        latest = json;
        setState(json);
      } catch {
        // 取得の失敗は表面化しない。ここが落ちても「このPC」での起動は使えるため、
        // エラー表示で導線を覆うより、サブPCの選択肢が出ないだけの方が害が小さい
      } finally {
        inFlight = false;
        if (!cancelled) {
          timerId = setTimeout(
            poll,
            hasActiveJob(latest) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
          );
        }
      }
    }

    function poll() {
      // バックグラウンドタブでは取得せず周期だけ進める（復帰時に即時取得する）
      if (document.hidden) {
        timerId = setTimeout(poll, IDLE_POLL_INTERVAL_MS);
        return;
      }
      void load();
    }

    function handleVisibilityChange() {
      if (document.hidden || inFlight) return;
      clearTimeout(timerId);
      poll();
    }

    void load();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, reloadKey]);

  /** ジョブを積む。拒否された場合はAPIが返した理由をそのままerrorへ入れる */
  const enqueue = useCallback(
    async (params: {
      repositoryFullName: string;
      issueNumber: number;
      hostName: string;
    }): Promise<boolean> => {
      setIsSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repository: params.repositoryFullName,
            issue: params.issueNumber,
            host: params.hostName,
          }),
        });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        const json = (await res.json()) as { job: DispatchJobView };
        // 次のポーリングを待たずに「順番待ち」を出す。押した直後こそ反応が要る
        setState((prev) => (prev ? { ...prev, jobs: [json.job, ...prev.jobs] } : prev));
        setReloadKey((key) => key + 1);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [],
  );

  /**
   * 走っているセッションへの操作（停止・終了・追加指示）を積む（#1332・#1012）。
   *
   * **失敗の理由を`error`（共有）へ入れず、戻り値で返す。** `error`は起動ボタンの下に
   * 出ているため、停止に失敗した理由がそちらへ出ると、押した場所と表示が離れて話が通じない。
   *
   * 送信の直後に画面を変えないのは、積んだジョブが次の取得で`jobs`へ現れ、
   * そちらが「送信しました」を出すため（起動と同じ扱い）。
   */
  const sendSessionControl = useCallback(
    async (params: {
      repositoryFullName: string;
      issueNumber: number;
      hostName: string;
      kind: "interrupt" | "kill" | "instruction";
      /** `kind`が`instruction`のときの本文（#1012）。1行・500文字まで */
      instruction?: string;
    }): Promise<{ ok: true } | { ok: false; message: string }> => {
      setIsSubmitting(true);
      try {
        const res = await fetch("/api/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repository: params.repositoryFullName,
            issue: params.issueNumber,
            host: params.hostName,
            kind: params.kind,
            instruction: params.instruction,
          }),
        });
        if (!res.ok) return { ok: false, message: await readErrorMessage(res) };
        setReloadKey((key) => key + 1);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      } finally {
        setIsSubmitting(false);
      }
    },
    [],
  );

  const cancel = useCallback(async (jobId: string): Promise<boolean> => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/dispatch/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      setReloadKey((key) => key + 1);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  return {
    hosts: state?.hosts ?? [],
    jobs: state?.jobs ?? [],
    sessions: state?.sessions ?? [],
    concurrency: state?.concurrency ?? null,
    error,
    setError,
    isSubmitting,
    enqueue,
    sendSessionControl,
    cancel,
  };
}
