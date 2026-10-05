/**
 * 本番デプロイ失敗からの復旧系列（#3998）の状態と、1巡ぶんの状態遷移。
 *
 * **判断と外部操作を分ける。** ここはIOを持たない純関数だけを置き、GitHub・DB・dispatchへの操作は
 * `deploy-recovery-series-run.ts`が持つ。巡回が何度来ても・再起動を挟んでも、同じ観測から同じ判断が
 * 出るようにするため。
 *
 * **第1段では本番反映の手前で止まる。** develop向けの修正PRがマージされた時点で`awaiting_release`
 * （本番反映待ち。人の対応が要る終端）へ進め、`recovered`（復旧済み）へは遷移させない。
 * 復旧済みと言えるのは対象版の稼働を確かめたときだけで、その確認は#4007で足す。
 */

/** 系列全体で使える修復回数（内側のPR修復も含む）。 */
export const DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS = 3;
/** 開始から期限までの時間。超えたら止める（無制限に走らせない）。 */
export const DEPLOY_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
/** 実装を起動してから原因の区分が報告されるまで待つ時間。 */
export const DEPLOY_RECOVERY_CAUSE_TIMEOUT_MS = 90 * 60 * 1000;
/** 起動の準備（修正Issue・dispatch）が途中で止まったとみなす時間。 */
export const DEPLOY_RECOVERY_PREPARING_TIMEOUT_MS = 10 * 60 * 1000;

/** 開始時に許可する範囲。第1段は「修正PRをdevelopへ入れるまで」。 */
export const DEPLOY_RECOVERY_SCOPE = "fix_until_develop";

export const DEPLOY_RECOVERY_STATUSES = [
  "starting",
  "preparing",
  "investigating",
  "fixing",
  "awaiting_checks",
  "awaiting_release",
  "releasing",
  "verifying",
  "recovered",
  "needs_attention",
  "stopped",
] as const;
export type DeployRecoveryStatus = (typeof DEPLOY_RECOVERY_STATUSES)[number];

/** 終わった（巡回が進めない）状態。`awaiting_release`も第1段では人へ渡す終端。 */
export const DEPLOY_RECOVERY_TERMINAL_STATUSES: readonly DeployRecoveryStatus[] = [
  "awaiting_release",
  "recovered",
  "needs_attention",
  "stopped",
];

export function isDeployRecoveryActive(status: string): boolean {
  return !DEPLOY_RECOVERY_TERMINAL_STATUSES.includes(status as DeployRecoveryStatus);
}

export const DEPLOY_RECOVERY_CAUSES = ["code", "config", "database", "external", "unknown"] as const;
export type DeployRecoveryCause = (typeof DEPLOY_RECOVERY_CAUSES)[number];

export type DeployRecoveryStopReason =
  | "timed_out"
  | "cause_not_reported"
  | "non_code_cause"
  | "dispatch_failed"
  | "pull_request_closed"
  | "repair_stopped"
  | "max_rounds_reached"
  | "stopped_by_user";

/** 実装セッションが原因の区分を報告するコメントのマーカー。修正Issueの本文で書き方を指示する。 */
export const DEPLOY_RECOVERY_CAUSE_MARKER_PREFIX = "issue-deck-deploy-recovery-cause:";

export function deployRecoverySeriesMarker(seriesId: string): string {
  return `<!-- issue-deck-deploy-recovery-series:${seriesId} -->`;
}

/**
 * コメント本文から原因の区分を読む。**最後に報告されたものを正とする**（調べ直して区分を改めることがあるため）。
 * 区分にない値は`unknown`として扱い、コード修正へは進めない。
 */
export function parseDeployRecoveryCause(bodies: readonly (string | null | undefined)[]): DeployRecoveryCause | null {
  let found: DeployRecoveryCause | null = null;
  const pattern = new RegExp(`<!--\\s*${DEPLOY_RECOVERY_CAUSE_MARKER_PREFIX}([a-z_-]+)\\s*-->`, "g");
  for (const body of bodies) {
    if (!body) continue;
    for (const match of body.matchAll(pattern)) {
      const value = match[1];
      found = (DEPLOY_RECOVERY_CAUSES as readonly string[]).includes(value) ? (value as DeployRecoveryCause) : "unknown";
    }
  }
  return found;
}

export type DeployRecoverySeriesState = {
  status: DeployRecoveryStatus;
  expiresAt: Date;
  dispatchedAt: Date | null;
  cause: DeployRecoveryCause | null;
  pullRequestNumber: number | null;
  repairRoundsBase: number;
};

export type DeployRecoveryObservation = {
  now: Date;
  /** 修正Issueのコメントから読んだ原因の区分。未報告ならnull */
  reportedCause: DeployRecoveryCause | null;
  /** 修正Issueに対応するdevelop向けPR（`issue-<番号>`）。無ければnull */
  pullRequest: { number: number; state: "open" | "closed"; merged: boolean } | null;
  /** そのPRの自動修復系列。まだ渡していなければnull */
  repairLoop: { status: string; round: number; stopReason: string | null } | null;
};

export type DeployRecoveryDecision =
  | { action: "wait" }
  | { action: "transition"; status: DeployRecoveryStatus; cause?: DeployRecoveryCause; pullRequestNumber?: number }
  | { action: "enroll_repair"; pullRequestNumber: number; maxRounds: number }
  | { action: "stop"; reason: DeployRecoveryStopReason; detail?: string };

/** 系列全体で使った修復回数。前のPRまでの分と、いまのPRの修復系列の分を足す。 */
export function deployRecoveryRoundsUsed(
  series: Pick<DeployRecoverySeriesState, "repairRoundsBase">,
  repairLoop: DeployRecoveryObservation["repairLoop"],
): number {
  return series.repairRoundsBase + (repairLoop?.round ?? 0);
}

/**
 * 1巡ぶんの判断。`starting`・`preparing`（修正Issueの作成とdispatch）は外部操作そのものなので
 * 呼び出し側が持ち、ここでは扱わない（`wait`を返す）。
 */
export function decideDeployRecovery(
  series: DeployRecoverySeriesState,
  observation: DeployRecoveryObservation,
): DeployRecoveryDecision {
  if (!isDeployRecoveryActive(series.status)) return { action: "wait" };
  if (observation.now.getTime() >= series.expiresAt.getTime()) return { action: "stop", reason: "timed_out" };
  if (series.status === "starting" || series.status === "preparing") return { action: "wait" };

  if (series.status === "investigating") {
    const cause = observation.reportedCause;
    if (cause === null) {
      const waited = series.dispatchedAt ? observation.now.getTime() - series.dispatchedAt.getTime() : 0;
      return waited >= DEPLOY_RECOVERY_CAUSE_TIMEOUT_MS ? { action: "stop", reason: "cause_not_reported" } : { action: "wait" };
    }
    // コード以外（設定・Secrets・DB状態・外部障害・不明）はコード修正では直らない。PRが出ていても先へ進めない。
    if (cause !== "code") return { action: "stop", reason: "non_code_cause", detail: cause };
    return { action: "transition", status: "fixing", cause };
  }

  // ここから先はコードの修正として進んでいる系列だけ。
  const pullRequest = observation.pullRequest;
  if (series.status === "fixing") {
    if (pullRequest === null) return { action: "wait" };
    return { action: "transition", status: "awaiting_checks", pullRequestNumber: pullRequest.number };
  }

  if (series.status === "awaiting_checks") {
    if (pullRequest === null) return { action: "wait" };
    // **マージされたら本番反映待ちで止める。** 第1段ではmainへ出す操作をしないため、
    // ここを`recovered`へ写すと「PRがマージされただけで復旧済み」になってしまう。
    if (pullRequest.merged) return { action: "transition", status: "awaiting_release" };
    if (pullRequest.state === "closed") return { action: "stop", reason: "pull_request_closed" };

    const loop = observation.repairLoop;
    const used = deployRecoveryRoundsUsed(series, loop);
    if (loop === null) {
      const remaining = DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS - series.repairRoundsBase;
      if (remaining <= 0) return { action: "stop", reason: "max_rounds_reached" };
      return { action: "enroll_repair", pullRequestNumber: pullRequest.number, maxRounds: remaining };
    }
    if (loop.status === "stopped") {
      if (loop.stopReason === "max_rounds_reached" || used >= DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS) {
        return { action: "stop", reason: "max_rounds_reached" };
      }
      return { action: "stop", reason: "repair_stopped", detail: loop.stopReason ?? undefined };
    }
    // 修復が終わった（CI・レビューが通った）あとは、developへの自動マージを待つだけ。
    return { action: "wait" };
  }

  return { action: "wait" };
}

/** 画面に出す状態名。Issueの「合意したユーザー体験」の7つに寄せる。 */
export function deployRecoveryStatusLabel(status: string): string {
  switch (status) {
    case "starting":
    case "preparing":
    case "investigating":
      return "調査中";
    case "fixing":
      return "修正中";
    case "awaiting_checks":
      return "CI・レビュー待ち";
    case "awaiting_release":
      return "本番反映待ち";
    case "releasing":
      return "本番反映中";
    case "verifying":
      return "復旧確認中";
    case "recovered":
      return "復旧済み";
    case "stopped":
      return "停止済み";
    default:
      return "要対応";
  }
}

export function deployRecoveryStopReasonLabel(reason: string | null, detail: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case "timed_out":
      return "期限（24時間）を過ぎたため止めました。";
    case "cause_not_reported":
      return "実装セッションが原因の区分を報告しないまま時間が過ぎました。修正Issueとセッションの様子を確かめてください。";
    case "non_code_cause":
      return `原因はコードの修正では直らない区分（${causeLabel(detail)}）と報告されました。修正Issueのコメントにある次の操作を確かめてください。`;
    case "dispatch_failed":
      return `実装を起動できませんでした${detail ? `（${detail}）` : ""}。`;
    case "pull_request_closed":
      return "修正PRがマージされずに閉じられました。";
    case "repair_stopped":
      return `修正PRの自動修復が止まりました${detail ? `（${detail}）` : ""}。PRを確かめてください。`;
    case "max_rounds_reached":
      return `修復の上限（${DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS}回）に達しました。`;
    case "stopped_by_user":
      return "停止しました。新しい修復・マージは始めません（すでに動いている実装セッションは止まりません）。";
    default:
      return reason;
  }
}

function causeLabel(cause: string | null): string {
  switch (cause) {
    case "config":
      return "設定・Secrets";
    case "database":
      return "DB状態";
    case "external":
      return "外部障害";
    default:
      return "不明";
  }
}
