/**
 * 本番復旧系列（#3998）のmain向け復旧PRを、**系列の記録だけを根拠に**自動マージしてよいかの判定（#4006）。
 *
 * 通常リリース（develop→main）は人がマージする（CLAUDE.md「自動マージ不可カテゴリ」）。ここはその例外で、
 * **ユーザーが「mainへの反映まで」を許可して開始した復旧系列の、記録済みの復旧PR1本だけ**に限る。
 * ラベルやPR本文のマーカーは権限として読まない（公開リポジトリでは誰でも書けるため）。
 *
 * IOを持たない純関数だけを置く。GitHubの観測と実際のマージは`deploy-recovery-series-run.ts`が行い、
 * マージ直前にも同じ判定を観測し直して呼ぶ。
 */

/** 開始時に許可する範囲。修正PRをdevelopへ入れるまで（第1段）。 */
export const DEPLOY_RECOVERY_SCOPE_DEVELOP = "fix_until_develop";
/** 開始時に許可する範囲。復旧PRのmainへのマージまで。 */
export const DEPLOY_RECOVERY_SCOPE_MAIN = "fix_until_main";

export const DEPLOY_RECOVERY_SCOPES = [DEPLOY_RECOVERY_SCOPE_DEVELOP, DEPLOY_RECOVERY_SCOPE_MAIN] as const;
export type DeployRecoveryScope = (typeof DEPLOY_RECOVERY_SCOPES)[number];

export function parseDeployRecoveryScope(value: unknown): DeployRecoveryScope | null {
  return (DEPLOY_RECOVERY_SCOPES as readonly unknown[]).includes(value) ? (value as DeployRecoveryScope) : null;
}

/** 開始者がmainへの反映まで許可した系列か。 */
export function allowsMainMerge(scope: string): boolean {
  return scope === DEPLOY_RECOVERY_SCOPE_MAIN;
}

/** 復旧PRに付いていたら自動マージしないラベル（人がマージ前に見るための既存の合図）。 */
export const DEPLOY_RECOVERY_MAIN_MERGE_BLOCKING_LABELS = ["22.merge-confirm-required", "00.check-user"] as const;

/** 復旧PRの変更ファイル数をこの件数以上で打ち切る（GitHubのAPIは300件までしか返さない）。 */
export const DEPLOY_RECOVERY_PULL_FILES_LIMIT = 300;

export type RecoveryMergeSeries = {
  status: string;
  scope: string;
  expiresAt: Date;
  stoppedAt: Date | null;
  startedByUserId: string;
  /** developへマージ済みの修正PRのマージコミット。mainへ取り込まれたかの判定に使う */
  fixMergeCommitSha: string | null;
  /** 復旧PRを作ったときの記録 */
  recoveryPullRequestNumber: number | null;
  recoveryHeadRef: string | null;
  recoveryHeadSha: string | null;
  recoveryBaseSha: string | null;
  /** 復旧PRを作ったときの変更ファイル（`package.json`を含む）。これ以外が増えたら止める */
  recoveryFiles: readonly string[];
};

export type RecoveryMergeObservation = {
  now: Date;
  pullRequest: {
    number: number;
    state: "open" | "closed";
    merged: boolean;
    baseRef: string;
    headRef: string;
    headSha: string;
    /** `false`＝コンフリクト・`null`＝GitHubが判定中 */
    mergeable: boolean | null;
    labels: readonly string[];
  } | null;
  /** 現在のmainの先端 */
  mainSha: string | null;
  /** 修正PRのマージコミットが、すでにmainの履歴に入っているか（別のリリースで取り込まれた） */
  fixAlreadyInMain: boolean;
  /** **現在のHEAD**のCI。develop上の合格は流用しない */
  ciState: "pending" | "success" | "failure" | "unknown";
  /** 復旧PRの現在の変更ファイル。取得できなければnull、打ち切られていたらtruncated */
  files: { names: readonly string[]; truncated: boolean } | null;
};

export type RecoveryMergeStopReason =
  | "timed_out"
  | "stopped_by_user"
  | "scope_not_allowed"
  | "recovery_pull_request_closed"
  | "recovery_pull_request_mismatch"
  | "head_changed"
  | "base_changed"
  | "superseded_by_release"
  | "diff_out_of_scope"
  | "ci_failed"
  | "blocked_by_label";

export type RecoveryMergeDecision =
  | { action: "wait"; reason: string }
  | { action: "stop"; reason: RecoveryMergeStopReason; detail?: string }
  | { action: "merge" };

/**
 * 1巡ぶんの判定。**権限の検査（開始者・範囲・期限・停止）を先に、PRの検査を後に**行い、
 * どれか1つでも外れれば`merge`を返さない。`wait`はまだ判定できないだけで、権限は与えない。
 */
export function decideRecoveryMainMerge(
  series: RecoveryMergeSeries,
  observation: RecoveryMergeObservation,
): RecoveryMergeDecision {
  if (series.stoppedAt !== null || series.status === "stopped") return { action: "stop", reason: "stopped_by_user" };
  if (!series.startedByUserId || !allowsMainMerge(series.scope)) return { action: "stop", reason: "scope_not_allowed" };
  if (observation.now.getTime() >= series.expiresAt.getTime()) return { action: "stop", reason: "timed_out" };
  if (series.status !== "awaiting_main_merge") return { action: "wait", reason: "status" };

  // 別のリリースが先にこの修正を取り込んでいたら、復旧PRは不要（置換済み）。
  if (observation.fixAlreadyInMain) return { action: "stop", reason: "superseded_by_release" };

  if (series.recoveryPullRequestNumber === null || !series.recoveryHeadSha || !series.recoveryBaseSha) {
    return { action: "wait", reason: "recovery_pull_request_not_created" };
  }
  const pull = observation.pullRequest;
  if (pull === null) return { action: "wait", reason: "pull_request_unobserved" };
  // 記録した復旧PR（番号・ブランチ・base）以外は、ラベルや本文が何であっても対象にしない。
  if (pull.number !== series.recoveryPullRequestNumber || pull.baseRef !== "main" || pull.headRef !== series.recoveryHeadRef) {
    return { action: "stop", reason: "recovery_pull_request_mismatch" };
  }
  if (pull.merged) return { action: "wait", reason: "already_merged" };
  if (pull.state === "closed") return { action: "stop", reason: "recovery_pull_request_closed" };

  // 記録したHEADから動いていたら、検証した差分とは別物になっている。
  if (pull.headSha !== series.recoveryHeadSha) return { action: "stop", reason: "head_changed" };
  // mainが進んだら差分と判定を前提から取り直す必要がある。無関係なリリースの先行は系列を止める。
  if (observation.mainSha === null) return { action: "wait", reason: "main_unobserved" };
  if (observation.mainSha !== series.recoveryBaseSha) return { action: "stop", reason: "base_changed" };

  const blocking = pull.labels.filter((label) =>
    (DEPLOY_RECOVERY_MAIN_MERGE_BLOCKING_LABELS as readonly string[]).includes(label),
  );
  if (blocking.length > 0) return { action: "stop", reason: "blocked_by_label", detail: blocking.join(", ") };

  // 実際のPRの現在の差分を機械検証する（修正だけが入っていること）。
  const files = observation.files;
  if (files === null) return { action: "wait", reason: "files_unobserved" };
  if (files.truncated || files.names.length >= DEPLOY_RECOVERY_PULL_FILES_LIMIT) {
    return { action: "stop", reason: "diff_out_of_scope", detail: "変更ファイルが多すぎて差分を検証できません" };
  }
  const allowed = new Set(series.recoveryFiles);
  const unexpected = files.names.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    return { action: "stop", reason: "diff_out_of_scope", detail: unexpected.slice(0, 5).join(", ") };
  }

  if (observation.ciState === "failure") return { action: "stop", reason: "ci_failed" };
  if (observation.ciState !== "success") return { action: "wait", reason: `ci_${observation.ciState}` };
  if (pull.mergeable === false) return { action: "stop", reason: "base_changed", detail: "コンフリクトしています" };
  if (pull.mergeable === null) return { action: "wait", reason: "mergeable_unknown" };
  return { action: "merge" };
}

export function recoveryMergeStopMessage(reason: string, detail: string | null): string {
  const suffix = detail ? `（${detail}）` : "";
  switch (reason) {
    case "recovery_pull_request_closed":
      return "復旧PRがマージされずに閉じられました。";
    case "recovery_pull_request_mismatch":
      return "記録した復旧PRと一致しないため、自動マージしません。";
    case "head_changed":
      return "復旧PRのHEADが、検証した時点から変わっています。自動マージせず、差分を確かめてください。";
    case "base_changed":
      return `mainが進んだ（またはコンフリクトした）ため、復旧PRを自動マージしません${suffix}。差分を確かめて出し直してください。`;
    case "superseded_by_release":
      return "修正がすでに別のリリースでmainへ取り込まれているため、復旧PRのマージは不要です（置換済み）。";
    case "diff_out_of_scope":
      return `復旧PRの差分が、取り込む修正の範囲を超えています${suffix}。自動マージしません。`;
    case "ci_failed":
      return "復旧PRの現在のHEADでCIが失敗しました。自動マージしません。";
    case "blocked_by_label":
      return `復旧PRに人の確認を求めるラベルが付いているため、自動マージしません${suffix}。`;
    case "merge_failed":
      return `復旧PRのマージに失敗しました${suffix}。`;
    default:
      return reason;
  }
}
