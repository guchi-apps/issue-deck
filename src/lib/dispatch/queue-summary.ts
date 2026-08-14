import {
  isActiveDispatchJobStatus,
  isDispatchHostAtSessionCapacity,
  type DispatchHostView,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";

/**
 * 実行キューの要約（#1266）。
 *
 * GitHub Actionsで並列に一括で流す使い方をやめ、**サブPCで順に流す**形にしたため
 * （#1261）、「今どこまで進んでいて、あと何本待っているか」を1か所で見られる必要が出た。
 *
 * **順番はcreatedAtの昇順で、払い出し（`claimDispatchJob`）と同じ。** キューは
 * 積んだ順に流れるので、画面の並びと実際に走る順が一致する。
 */

/** 未完了ジョブのうち、実際に走っているとみなす状態 */
function isRunningStatus(job: DispatchJobView): boolean {
  return job.status === "CLAIMED" || job.status === "RUNNING";
}

export type DispatchQueueSummary = {
  /** 走っているジョブ（積んだ順） */
  running: DispatchJobView[];
  /** 順番待ち（積んだ順＝払い出される順） */
  queued: DispatchJobView[];
  /** 直近24時間に失敗・タイムアウトしたもの（新しい順） */
  failed: DispatchJobView[];
  /** 同時実行数の上限。ホストの申告と設定の小さい方が入る（不明ならnull） */
  concurrency: number | null;
  /** バッジに出す件数。走っている数＋待っている数 */
  activeCount: number;
};

export function summarizeDispatchQueue(
  jobs: readonly DispatchJobView[],
  concurrency: number | null,
): DispatchQueueSummary {
  // **起動ジョブだけを数える**（#1332）。セッションの停止・終了は同時実行数の枠を使わず、
  // tmuxを1回叩いて終わるため、ここへ混ぜると「実行中 3/2」のような数え方になる。
  // 制御ジョブの状態はそのIssueのセッション表示（`issue-session-status.tsx`）に出る
  const byOldest = [...jobs]
    .filter((job) => job.kind === "LAUNCH")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const running = byOldest.filter(isRunningStatus);
  const queued = byOldest.filter((job) => job.status === "QUEUED");
  const failed = byOldest
    .filter((job) => job.status === "FAILED" || job.status === "TIMEOUT")
    .reverse();

  return {
    running,
    queued,
    failed,
    concurrency,
    activeCount: running.length + queued.length,
  };
}

/** ヘッダーのバッジに出す1行（例:「実行中 2/2・待機 3」） */
export function describeDispatchQueueLoad(summary: DispatchQueueSummary): string {
  const running =
    summary.concurrency === null
      ? `実行中 ${summary.running.length}`
      : `実行中 ${summary.running.length}/${summary.concurrency}`;
  const queued = summary.queued.length > 0 ? `待機 ${summary.queued.length}` : null;
  return [running, queued].filter(Boolean).join("・");
}

/**
 * セッション本数の空き（#1394）。
 *
 * **同時実行数（`concurrency`）では待機の理由を説明できない。** あちらはジョブの払い出しにしか
 * 効かず、ジョブはtmuxセッションが立った時点で`succeeded`になるため、実際に起動を止めているのは
 * `DISPATCH_MAX_SESSIONS`（#1361）の方。上限に達している間、pollerは起動ジョブを取りに来ない。
 *
 * これが画面に出ていないと、「正常に上限で待っている」状態と「pollerが落ちている」状態が
 * 順番待ちの表示だけからは区別できない。
 */
export type DispatchSessionCapacity = {
  hostName: string;
  live: number;
  max: number;
  /** 上限に達しており、このホストは起動ジョブを取りに来ない */
  atCapacity: boolean;
};

/**
 * 申告のあるホストのセッション本数をまとめる。
 *
 * **本数を申告していないホスト（古いpoller）は落とす。** 判定材料が無いまま0本として並べると、
 * 実際には埋まっているホストが空いているように見える。
 */
export function summarizeDispatchSessionCapacity(
  hosts: readonly DispatchHostView[],
): DispatchSessionCapacity[] {
  return hosts
    .filter((host) => host.maxSessions !== null && host.liveSessions !== null)
    .map((host) => ({
      hostName: host.name,
      live: host.liveSessions as number,
      max: host.maxSessions as number,
      atCapacity: isDispatchHostAtSessionCapacity(host),
    }));
}

/**
 * 順番待ちが進まない理由（#1394）。理由が無ければ`null`。
 *
 * **応答しているホストだけを見る。** 落ちているホストは「上限で待っている」のではなく
 * 「取りに来られない」ので、別の話として扱う（そちらは従来どおり`online`の表示が持つ）。
 */
export function describeDispatchQueueStall(
  summary: DispatchQueueSummary,
  hosts: readonly DispatchHostView[],
): string | null {
  if (summary.queued.length === 0) return null;

  const blocked = summarizeDispatchSessionCapacity(hosts.filter((host) => host.online)).filter(
    (capacity) => capacity.atCapacity,
  );
  if (blocked.length === 0) return null;

  const names = blocked
    .map((capacity) => `${formatDispatchHostName(capacity.hostName)}（${capacity.live}/${capacity.max}本）`)
    .join("・");
  return `${names}がセッション本数の上限に達しているため、順番待ちは進みません。作業が終わったセッションが畳まれると自動で再開します。`;
}

/**
 * 1件のジョブが順番待ちのまま進まない理由（#1394）。理由が無ければ`null`。
 *
 * キュー全体の`describeDispatchQueueStall`と同じ説明を、**押した本人が見ている場所**
 * （Issue詳細のボタンの下）にも出すためのもの。ヘッダーのポップオーバーは開かないと見えず、
 * 「押したのに始まらない」と気づくのはIssueの画面の方が先。
 */
export function describeDispatchJobWaitReason(
  job: DispatchJobView,
  hosts: readonly DispatchHostView[],
): string | null {
  if (job.status !== "QUEUED" || job.kind !== "LAUNCH") return null;
  const host = hosts.find((candidate) => candidate.name === job.targetHost);
  // 落ちているホストは「上限で待っている」のではなく「取りに来られない」。別の話として扱う
  if (!host || !host.online || !isDispatchHostAtSessionCapacity(host)) return null;
  return `${formatDispatchHostName(host.name)}のセッションが上限（${host.liveSessions}/${host.maxSessions}本）に達しているため、まだ起動できません。作業が終わったセッションが畳まれると順に起動します。`;
}

/** まとめて取り消せるジョブ（`queued`・`claimed`まで。`running`は途中で止めると中途半端なworktreeが残る） */
export function cancelableDispatchJobs(
  summary: DispatchQueueSummary,
): DispatchJobView[] {
  return [...summary.queued, ...summary.running.filter((job) => job.status === "CLAIMED")];
}

/** 未完了ジョブが1件でもあるか（ポーリング間隔の切り替えと同じ判定を画面でも使う） */
export function hasActiveDispatchJobs(jobs: readonly DispatchJobView[]): boolean {
  return jobs.some((job) => isActiveDispatchJobStatus(job.status));
}
