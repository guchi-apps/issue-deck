import {
  isActiveDispatchJobStatus,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";

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
  const byOldest = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

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
