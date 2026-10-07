/**
 * GitHub Actions障害時のバックアップCI（CircleCI・#4065）の純関数。
 *
 * **状態の正本はissue-deckの`BackupCiRun`。** CircleCIのジョブが「成功」でも、起動時に記録した
 * head/base・検査定義・検査項目と一致しない結果は合格として採用しない。逆に、PRのhead/baseが
 * 起動後に変わったら、どれだけ前の結果が合格でも採用しない（再検証を求める）。
 */

export const BACKUP_CI_RUN_STATUSES = [
  /** 行を作り、CircleCIへの起動要求を送っている最中 */
  "requesting",
  /** CircleCIがパイプラインを受け付けた。結果待ち */
  "running",
  /** 検査が全部通り、記録と突き合わせても矛盾が無い */
  "passed",
  /** 検査が失敗した（どれかの検査が落ちた・ジョブが失敗した） */
  "failed",
  /** 結果は返ったが、記録と一致しない（SHA・定義・検査の欠落）。**合格にしない** */
  "invalid",
  /** CircleCIが起動を拒否した（未設定・権限不足・無料枠不足など） */
  "trigger_failed",
  /** 起動要求の応答が不明（タイムアウト・接続断）。**確認せず再送しない** */
  "trigger_unknown",
  /** 時間切れ・キャンセル・結果を取得できない。**合格にしない** */
  "unverifiable",
  /** 実行中・完了後にPRのhead/baseが変わった。この結果は使わない */
  "superseded",
] as const;
export type BackupCiRunStatus = (typeof BACKUP_CI_RUN_STATUSES)[number];

export function parseBackupCiRunStatus(value: unknown): BackupCiRunStatus | null {
  return typeof value === "string" && (BACKUP_CI_RUN_STATUSES as readonly string[]).includes(value)
    ? (value as BackupCiRunStatus)
    : null;
}

/** 未完了（同じPRで次の実行要求を受け付けない）状態 */
export function isBackupCiRunActive(status: BackupCiRunStatus): boolean {
  return status === "requesting" || status === "running";
}

/** 同じPRで実行要求を2本同時に採用しないための活性キー */
export function buildBackupCiActiveKey(repositoryFullName: string, prNumber: number): string {
  return `backup_ci:${repositoryFullName}#${prNumber}`;
}

/** 起動から完了を待つ上限。Actionsのジョブ（数分〜15分）に対して十分長く取る */
export const BACKUP_CI_RUN_TIMEOUT_MS = 90 * 60 * 1000;
/** `requesting`のまま残った行（起動処理の途中でプロセスが落ちた）を応答不明とみなすまで */
export const BACKUP_CI_REQUESTING_STALE_MS = 5 * 60 * 1000;

/** 画面に出す区分（Issue #4065「Actions待機中／CircleCIで代替実行中／成功／失敗／結果確認不能」） */
export type BackupCiDisplayKind = "running" | "passed" | "failed" | "unknown" | "stale";

export function backupCiDisplayKind(status: BackupCiRunStatus): BackupCiDisplayKind {
  switch (status) {
    case "requesting":
    case "running":
      return "running";
    case "passed":
      return "passed";
    case "failed":
    case "invalid":
    case "trigger_failed":
      return "failed";
    case "trigger_unknown":
    case "unverifiable":
      return "unknown";
    case "superseded":
      return "stale";
  }
}

export const BACKUP_CI_STATUS_LABELS: Record<BackupCiRunStatus, string> = {
  requesting: "CircleCIへ起動を要求中",
  running: "CircleCIで代替実行中",
  passed: "バックアップCI成功",
  failed: "バックアップCI失敗",
  invalid: "結果が記録と一致しないため不合格",
  trigger_failed: "起動できませんでした",
  trigger_unknown: "起動結果が不明（結果確認不能）",
  unverifiable: "結果確認不能",
  superseded: "PRが更新されたため無効",
};

// ---------------------------------------------------------------------------
// 検査定義（ci/required-checks.json）

export type RequiredCheckDefinition = { group: string; id: string; name: string };

/** 定義から必須の検査一覧を取り出す。形が崩れていればnull（**0件を「検査なしで合格」にしない**） */
export function expandRequiredChecks(manifest: unknown): RequiredCheckDefinition[] | null {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || !isRecord(manifest.groups)) return null;
  const checks: RequiredCheckDefinition[] = [];
  for (const [group, value] of Object.entries(manifest.groups)) {
    if (!isRecord(value) || !Array.isArray(value.checks) || value.checks.length === 0) return null;
    for (const check of value.checks) {
      if (!isRecord(check) || typeof check.id !== "string" || typeof check.run !== "string") return null;
      checks.push({ group, id: check.id, name: typeof check.name === "string" ? check.name : check.id });
    }
  }
  return checks.length > 0 ? checks : null;
}

// ---------------------------------------------------------------------------
// 結果の検証

export type BackupCiCheckResult = {
  group: string;
  id: string;
  name: string;
  status: "passed" | "failed" | "missing";
};

export type BackupCiRunRecord = {
  id: string;
  headSha: string;
  baseSha: string;
  definitionDigest: string | null;
};

export type BackupCiVerdict =
  | { status: "passed"; checks: BackupCiCheckResult[]; testedSha: string; testedParents: string[]; resultDigest: string }
  | { status: "failed" | "invalid"; reason: string; checks: BackupCiCheckResult[] };

/**
 * CircleCIのジョブの結論と結果JSON（`ci-result.json`）を、起動時の記録と突き合わせる。
 *
 * - ジョブが成功でも、結果JSONが無い・読めない・定義が違う・検査が欠けている → `invalid`
 * - 結果JSONの要求SHA・実行要求IDが記録と違う → `invalid`（別の実行の結果を拾った）
 * - 検査したコミットの親が[base, head]でない → `invalid`（マージ結果を検査していない）
 * - どれかの検査が失敗・ジョブが失敗 → `failed`
 */
export function evaluateBackupCiResult(input: {
  run: BackupCiRunRecord;
  expectedChecks: RequiredCheckDefinition[];
  jobSucceeded: boolean;
  result: unknown;
}): BackupCiVerdict {
  const { run, expectedChecks, jobSucceeded, result } = input;
  const reported = isRecord(result) && Array.isArray(result.checks) ? result.checks.filter(isRecord) : [];
  const checks: BackupCiCheckResult[] = expectedChecks.map((expected) => {
    const found = reported.find((r) => r.id === expected.id && r.group === expected.group);
    const status = found?.status === "passed" ? "passed" : found?.status === "failed" ? "failed" : "missing";
    return { group: expected.group, id: expected.id, name: expected.name, status };
  });

  if (!isRecord(result)) {
    return jobSucceeded
      ? { status: "invalid", reason: "検査結果（ci-result.json）を取得できませんでした。", checks }
      : { status: "failed", reason: "検査結果が出る前にジョブが失敗しました（依存関係の導入・マージ等）。", checks };
  }
  if (run.definitionDigest == null || result.definitionDigest !== run.definitionDigest) {
    return { status: "invalid", reason: "検査定義の版が、PRのbaseにある定義と一致しません。", checks };
  }
  if (result.requestedHeadSha !== run.headSha || result.requestedBaseSha !== run.baseSha) {
    return { status: "invalid", reason: "検査したhead/baseが、実行要求と一致しません。", checks };
  }
  if (result.runRequestId !== run.id) {
    return { status: "invalid", reason: "結果の実行要求IDが一致しません（別の実行の結果です）。", checks };
  }
  const parents = Array.isArray(result.testedParents) ? result.testedParents.filter((p) => typeof p === "string") : [];
  if (typeof result.testedSha !== "string" || parents.length !== 2 || parents[0] !== run.baseSha || parents[1] !== run.headSha) {
    return { status: "invalid", reason: "baseへheadをマージした結果を検査していません。", checks };
  }
  const failed = checks.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    return { status: "failed", reason: `必須検査が失敗しました: ${failed.map((c) => c.name).join("、")}`, checks };
  }
  const missing = checks.filter((c) => c.status === "missing");
  if (missing.length > 0) {
    return { status: "invalid", reason: `必須検査の結果が欠けています: ${missing.map((c) => c.name).join("、")}`, checks };
  }
  if (!jobSucceeded) {
    return { status: "failed", reason: "検査は通りましたが、CircleCIのジョブが失敗で終わりました。", checks };
  }
  return {
    status: "passed",
    checks,
    testedSha: result.testedSha,
    testedParents: parents,
    resultDigest: result.definitionDigest as string,
  };
}

// ---------------------------------------------------------------------------
// 共通チェック（issue-deck/ci-gate）

export const CI_GATE_CONTEXT = "issue-deck/ci-gate";

export type CiGateDecision = {
  state: "success" | "failure" | "pending" | "error";
  description: string;
};

/**
 * バックアップCIの実行1件から、共通チェックへ出す状態を決める。**採用するのは、PRの現在の
 * head/baseに対して検証済みの合格だけ。** 失敗・不明・時間切れ・キャンセルは成功にしない。
 */
export function decideCiGateFromBackupRun(
  run: { status: BackupCiRunStatus; headSha: string; baseSha: string; statusReason: string | null },
  current: { headSha: string; baseSha: string },
): CiGateDecision {
  if (run.headSha !== current.headSha || run.baseSha !== current.baseSha || run.status === "superseded") {
    return { state: "pending", description: "PRが更新されたため、再検証が必要です" };
  }
  switch (run.status) {
    case "requesting":
    case "running":
      return { state: "pending", description: "バックアップCI（CircleCI）で検査中" };
    case "passed":
      return { state: "success", description: "バックアップCI（CircleCI）で必須検査に合格" };
    case "failed":
    case "invalid":
      return { state: "failure", description: truncate(run.statusReason ?? "バックアップCIが不合格でした", 140) };
    case "trigger_failed":
    case "trigger_unknown":
    case "unverifiable":
      return { state: "error", description: truncate(run.statusReason ?? "バックアップCIの結果を確認できません", 140) };
  }
}

// ---------------------------------------------------------------------------
// Webhook

export type CircleciWebhookEvent = {
  eventId: string;
  type: string;
  pipelineId: string | null;
  workflowId: string | null;
  workflowStatus: string | null;
};

export function parseCircleciWebhook(payload: unknown): CircleciWebhookEvent | null {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.type !== "string") return null;
  const pipeline = isRecord(payload.pipeline) ? payload.pipeline : null;
  const workflow = isRecord(payload.workflow) ? payload.workflow : null;
  return {
    eventId: payload.id,
    type: payload.type,
    pipelineId: typeof pipeline?.id === "string" ? pipeline.id : null,
    workflowId: typeof workflow?.id === "string" ? workflow.id : null,
    workflowStatus: typeof workflow?.status === "string" ? workflow.status : null,
  };
}

/** CircleCIのワークフローの状態のうち、もう変わらないもの */
export function isCircleciWorkflowTerminal(status: string): boolean {
  return ["success", "failed", "error", "canceled", "not_run", "unauthorized"].includes(status);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
