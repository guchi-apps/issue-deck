import type { DispatchAgent, DispatchJobView } from "@/lib/dispatch/dispatch-job";

/**
 * develop向けPRのAIレビュー（`DispatchJob.kind = PR_REVIEW`・#3990）の純関数。
 *
 * かつてはGitHub ActionsがPRコメントへ要求印を投稿し、サブPCが全リポジトリのopen PRを巡回して
 * 拾い、結果コメントが付くまでActionsが最大30分ポーリングしていた（#3917）。いまは**状態の正本が
 * DispatchJob**で、Actionsは積んで終わり、完了の報告を契機に最終マージ判定が再開される。
 * PRコメントのverdict markerは人が読むための結果の記録として残る（既存のparser・リリース集約と
 * 互換）が、ジョブキューとしては使わない。
 */

/** レビューの判定。`failed`は入れない（失敗・時間切れはジョブの`status`と`message`が持つ） */
export const PR_REVIEW_VERDICTS = ["lgtm", "needs-check", "changes-requested"] as const;
export type PrReviewVerdict = (typeof PR_REVIEW_VERDICTS)[number];

export function parsePrReviewVerdict(value: unknown): PrReviewVerdict | null {
  return typeof value === "string" && (PR_REVIEW_VERDICTS as readonly string[]).includes(value)
    ? (value as PrReviewVerdict)
    : null;
}

/** GitHubのコミットSHA（40桁）。SHA-256リポジトリの64桁も通す */
export function parsePrReviewSha(value: unknown): string | null {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : null;
}

/**
 * 二重レビューを止める活性キー。**同じPR・同じHEAD・同じagentの未完了は1件まで。**
 * 新しいpushでHEADが変われば別のキーになり、古いHEADのジョブとは並ぶ。
 */
export function buildPrReviewActiveKey(
  repositoryFullName: string,
  prNumber: number,
  headSha: string,
  agent: DispatchAgent,
): string {
  return `pr_review:${repositoryFullName}#${prNumber}@${headSha}:${agent}`;
}

/** Actionsのゲートが読む、あるHEADへのレビューの状態 */
export type PrReviewGateState =
  /** ジョブが無い（積まれていない・古い移行前のPR） */
  | { state: "missing" }
  /** キュー待ち・受付済み・実行中。最終マージ判定は結果が出るまで保留する */
  | { state: "pending"; phase: "queued" | "claimed" | "running"; host: string | null }
  /** 判定が出た */
  | { state: "done"; verdict: PrReviewVerdict }
  /** 判定が得られなかった（失敗・時間切れ・不正出力・見送り）。**自動マージしない** */
  | { state: "failed"; reason: string }
  /** 新しいHEADが積まれて取り消された。この結果は現在のマージ判定に使わない */
  | { state: "stale" };

export type PrReviewJobLike = {
  status: "QUEUED" | "CLAIMED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "TIMEOUT" | "CANCELED";
  reviewVerdict: string | null;
  message: string | null;
  claimedByHost: string | null;
  targetHost: string;
};

/** ジョブ1件をゲートの状態へ写す。**判定が読めない成功は失敗として扱う**（安全側） */
export function resolvePrReviewGateState(job: PrReviewJobLike | null): PrReviewGateState {
  if (job === null) return { state: "missing" };
  switch (job.status) {
    case "QUEUED":
      return { state: "pending", phase: "queued", host: job.targetHost };
    case "CLAIMED":
      return { state: "pending", phase: "claimed", host: job.claimedByHost ?? job.targetHost };
    case "RUNNING":
      return { state: "pending", phase: "running", host: job.claimedByHost ?? job.targetHost };
    case "SUCCEEDED": {
      const verdict = parsePrReviewVerdict(job.reviewVerdict);
      return verdict
        ? { state: "done", verdict }
        : { state: "failed", reason: "レビューは終了しましたが、判定が記録されていません。" };
    }
    case "CANCELED":
      return { state: "stale" };
    case "FAILED":
      return { state: "failed", reason: job.message ?? "レビューが失敗しました。" };
    case "TIMEOUT":
      return {
        state: "failed",
        reason: job.message ?? "サブPCからの応答が途絶えたためタイムアウトしました。",
      };
    case "SKIPPED":
      return { state: "failed", reason: job.message ?? "レビューが見送られました。" };
  }
}

/** 最終マージ判定を再開してよい（結果が確定した）状態か。`CANCELED`は古いHEADなので再開しない */
export function isPrReviewResumable(status: PrReviewJobLike["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "TIMEOUT" || status === "SKIPPED";
}

/** 再開を諦めるまでの、API失敗の許容回数。実行中のrunを待つ間は数えない */
export const PR_REVIEW_RESUME_MAX_ATTEMPTS = 10;
/** 結果が確定してから再開を試み続ける上限（ミリ秒）。それより古いPRはActionsのrunも畳まれている */
export const PR_REVIEW_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
/** QUEUEDのまま取りに来られないレビューを見限るまでは`DISPATCH_CONTROL_QUEUE_TIMEOUT_MS`に従う */

/** `review / auto-merge`のような、再利用ワークフロー経由のジョブ名から最終マージ判定のジョブを見分ける */
export function isAutoMergeJobName(name: string | undefined | null): boolean {
  return typeof name === "string" && /(^|\s\/\s)auto-merge$/.test(name.trim());
}

/** 画面・PRコメントに出す、起動前失敗も含めた状態の説明 */
export function describePrReviewGateState(state: PrReviewGateState): string {
  switch (state.state) {
    case "missing":
      return "レビューのジョブが積まれていません。";
    case "pending":
      return state.phase === "queued"
        ? "サブPCの受け取り待ちです。"
        : state.phase === "claimed"
          ? `サブPC（${state.host ?? "不明"}）が受け付けました。`
          : `サブPC（${state.host ?? "不明"}）でレビューを実行中です。`;
    case "done":
      return `レビューが完了しました（${state.verdict}）。`;
    case "failed":
      return state.reason;
    case "stale":
      return "新しいHEADが積まれたため、この結果は使いません。";
  }
}

/**
 * あるPRについての、画面に出すPRレビューのジョブ（新しい順）。`GET /api/dispatch`が返す
 * 未完了＋直近24時間の終了ジョブから引く。**古いHEADのジョブも残す**（結果は使われないが、
 * 「新しいHEADでやり直した」ことが読める）。
 */
export function selectPrReviewJobsForPullRequest(
  jobs: readonly DispatchJobView[],
  repositoryFullName: string,
  prNumber: number,
  limit = 5,
): DispatchJobView[] {
  return jobs
    .filter(
      (job) =>
        job.kind === "PR_REVIEW" && job.repositoryFullName === repositoryFullName && job.prNumber === prNumber,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** 現在のPRのHEADに対するジョブか。違えば結果は最終マージ判定に使われない（古いHEAD） */
export function isPrReviewJobStale(job: Pick<DispatchJobView, "headSha" | "status">, currentHeadSha: string): boolean {
  return job.status === "CANCELED" || (job.headSha != null && job.headSha !== currentHeadSha);
}

export const PR_REVIEW_VERDICT_LABELS: Record<PrReviewVerdict, string> = {
  lgtm: "問題なし（LGTM）",
  "needs-check": "要確認",
  "changes-requested": "要修正",
};
