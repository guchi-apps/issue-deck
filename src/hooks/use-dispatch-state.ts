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
 * **pull型なので、押してから起動が始まるまでに最大でポーリング間隔（既定30秒）かかる。**
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

/**
 * 取得中の表示（アイコンの回転）を保つ下限（#1773）。
 *
 * **叩き先は自前の`GET /api/dispatch`（DBの読み取りのみ）で、数十msで返ることが多い。**
 * 素直に「取得している間だけ`true`」にすると、回転が1周もせずに消えて点滅にしか見えず、
 * 更新されたことの合図として読めない。
 */
const MIN_FETCHING_MS = 500;

function hasActiveJob(state: DispatchState | null): boolean {
  return state?.jobs.some((job) => isActiveDispatchJobStatus(job.status)) ?? false;
}

/**
 * このフックを使っている**すべてのコンポーネント**へ「取り直せ」を配るための購読者（#1815）。
 *
 * 積んだジョブを自分の状態へ足すだけでは、**同じ画面の別のコンポーネントには届かない。**
 * Issueを作成して続けて起動した直後（`create-issue-dialog.tsx`の「作成+実装開始」）が
 * これで、ジョブを積むのは作成側のダイアログが持つ取得口、押した結果を出すのは
 * 裏で開いているIssue詳細の取得口、という別々のインスタンスになる。詳細側は次のポーリング
 * （何も動いていなければ20秒後）まで何も知らないため、その間ずっと押す前と同じ
 * 「サブPCで開始」が出たままになっていた。
 *
 * 配るのは合図だけで、状態は各インスタンスが`/api/dispatch`から取り直す（DBの読み取りのみ）。
 */
const refreshListeners = new Set<() => void>();

/** `except`（積んだ本人）以外へ配る。本人は自分で`reloadKey`を進めるため、二重に走らせない */
function notifyDispatchChanged(except: () => void) {
  for (const listener of refreshListeners) {
    if (listener !== except) listener();
  }
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
  /**
   * 最初の取得が終わったか（#1666）。**「取得中」ではなく「一度でも確定したか」。**
   *
   * `hosts`は取得前も`[]`を返すため、受け取る側からは「申告しているサブPCが1台も無い」と
   * 区別が付かない。実装開始のダイアログが選択肢を組み立てるのに使っているので、区別が付かないと
   * サブPC抜きの選択肢を先に出してから差し替えることになる。
   *
   * **失敗しても`true`にする。** 取得は20秒間隔で繰り返されるが、届かない間ずっと待たせるより、
   * 従来どおり（サブPCの選択肢が出ないだけ）で操作できる方が害が小さい。
   * ポーリングの2回目以降は`false`へ戻さない（戻すと20秒ごとに選択肢が消える）。
   */
  const [isLoaded, setIsLoaded] = useState(false);
  /**
   * 最後に**取得できた**時刻（epoch ms・#1773）。実行キューの「◯秒前に更新」に出す。
   *
   * **失敗したときは更新しない。** 取得の失敗は表面化しない作りなので（下の`load`）、
   * 失敗しても時刻を進めると「更新できていない」と「更新した結果が同じ」の区別が付かなくなる。
   * 進めずにおけば、経過だけが伸びて古いことが表示に出る。
   */
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  /** 取得中（#1773）。**操作の送信中（`isSubmitting`）とは別物**なので混ぜない */
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // enqueue・cancelの直後に取り直すためのキー。増やすと下のeffectが再実行される
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let fetchingTimerId: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let latest: DispatchState | null = null;

    async function load() {
      inFlight = true;
      const startedAt = Date.now();
      clearTimeout(fetchingTimerId);
      setIsFetching(true);
      try {
        const res = await fetch("/api/dispatch");
        if (!res.ok) return;
        const json = (await res.json()) as DispatchState;
        if (cancelled) return;
        latest = json;
        setState(json);
        setFetchedAt(Date.now());
      } catch {
        // 取得の失敗は表面化しない。ここが落ちても「このPC」での起動は使えるため、
        // エラー表示で導線を覆うより、サブPCの選択肢が出ないだけの方が害が小さい
      } finally {
        inFlight = false;
        if (!cancelled) {
          setIsLoaded(true);
          timerId = setTimeout(
            poll,
            hasActiveJob(latest) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
          );
          // 速すぎて見えない回転にしないための下限（#1773）
          const remaining = MIN_FETCHING_MS - (Date.now() - startedAt);
          if (remaining > 0) {
            fetchingTimerId = setTimeout(() => setIsFetching(false), remaining);
          } else {
            setIsFetching(false);
          }
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
      clearTimeout(fetchingTimerId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, reloadKey]);

  /**
   * 次の自動更新を待たずに取り直す（#1773）。
   *
   * **積んだ直後の取り直し（`enqueue`・`cancel`ほか）と同じ経路**（`reloadKey`）を使う。
   * 押した瞬間にeffectが再実行されて`load()`が走るため、待ち時間は最大20秒から0になる。
   */
  const refresh = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  // 他のインスタンスが積んだ・取り消した合図を受けて取り直す（#1815）。**取得しない設定
  // （`enabled`がfalse）のときは購読しない**——閉じているダイアログのために取得を増やさない
  useEffect(() => {
    if (!enabled) return;
    refreshListeners.add(refresh);
    return () => {
      refreshListeners.delete(refresh);
    };
  }, [enabled, refresh]);

  /**
   * 自分の状態を取り直しつつ、**同じ画面の他のインスタンスにも取り直させる**（#1815）。
   * 積む・取り消す・送るのすべてで通す。
   */
  const markChanged = useCallback(() => {
    setReloadKey((key) => key + 1);
    notifyDispatchChanged(refresh);
  }, [refresh]);

  /** ジョブを積む。拒否された場合はAPIが返した理由をそのままerrorへ入れる */
  const enqueue = useCallback(
    async (params: {
      repositoryFullName: string;
      issueNumber: number;
      hostName: string;
      /**
       * 起動の種別。省略時は実装セッション（`LAUNCH`）。横断質問（#1454）だけが
       * `cross_repo_question`を渡す。**セッションを立てる種別に限る**（停止・終了・追加指示は
       * `sendSessionControl`が扱う）
       */
      kind?: "cross_repo_question";
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
            kind: params.kind,
          }),
        });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        const json = (await res.json()) as { job: DispatchJobView };
        // 次のポーリングを待たずに「順番待ち」を出す。押した直後こそ反応が要る
        setState((prev) => (prev ? { ...prev, jobs: [json.job, ...prev.jobs] } : prev));
        markChanged();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [markChanged],
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
        markChanged();
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      } finally {
        setIsSubmitting(false);
      }
    },
    [markChanged],
  );

  const cancel = useCallback(async (jobId: string): Promise<boolean> => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/dispatch/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      markChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [markChanged]);

  /**
   * 終了したジョブの表示を消す（#1479）。取り消し（`cancel`）とは別で、既に終わったものだけが対象。
   *
   * **成功したらポーリングを待たずに手元から落とす。** 次の取得まで最大20秒あり、その間
   * 消えないと押せていないように見える（サーバー側は`dismissedAt`が入っており、取り直しても戻らない）。
   */
  const dismiss = useCallback(async (jobId: string): Promise<boolean> => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/dispatch/${encodeURIComponent(jobId)}/dismiss`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      setState((prev) =>
        prev ? { ...prev, jobs: prev.jobs.filter((job) => job.id !== jobId) } : prev,
      );
      markChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [markChanged]);

  /**
   * 順番待ちのジョブを先頭へ上げる（#1541）。
   *
   * **成功したらポーリングを待たずに手元の並びも直す。** 次の取得まで最大20秒あり、
   * その間に並びが変わらないと押せていないように見える。サーバー側の値と同じ規則
   * （同じホストの順番待ちの最大値+1）で置き換えるので、取り直しても並びは変わらない。
   */
  const prioritize = useCallback(async (jobId: string): Promise<boolean> => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/dispatch/${encodeURIComponent(jobId)}/prioritize`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      setState((prev) => {
        if (!prev) return prev;
        const target = prev.jobs.find((job) => job.id === jobId);
        if (!target) return prev;
        const top = prev.jobs.reduce(
          (max, job) =>
            job.targetHost === target.targetHost && job.status === "QUEUED"
              ? Math.max(max, job.queuePriority)
              : max,
          0,
        );
        return {
          ...prev,
          jobs: prev.jobs.map((job) =>
            job.id === jobId ? { ...job, queuePriority: top + 1 } : job,
          ),
        };
      });
      markChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, [markChanged]);

  return {
    hosts: state?.hosts ?? [],
    jobs: state?.jobs ?? [],
    sessions: state?.sessions ?? [],
    concurrency: state?.concurrency ?? null,
    isLoaded,
    fetchedAt,
    isFetching,
    /**
     * いま使っている取得間隔（#1773）。**上のeffectと同じ判定を使う**ので、画面に出す
     * 「20秒ごと」と実際の周期がずれない。
     */
    pollIntervalMs: hasActiveJob(state) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    refresh,
    error,
    setError,
    isSubmitting,
    enqueue,
    sendSessionControl,
    cancel,
    dismiss,
    prioritize,
  };
}
