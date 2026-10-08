import type { BackupCiRun, BackupCiSetting } from "@prisma/client";

import {
  type CircleciClient,
  circleciWorkflowUrl,
  createCircleciClient,
} from "@/lib/backup-ci/circleci-client";
import {
  BACKUP_CI_REQUESTING_STALE_MS,
  BACKUP_CI_RUN_TIMEOUT_MS,
  type BackupCiRunStatus,
  buildBackupCiActiveKey,
  evaluateBackupCiResult,
  isCircleciWorkflowTerminal,
  parseBackupCiRunStatus,
  parseCircleciWebhook,
} from "@/lib/backup-ci/state";
import { verifyCircleciSignature } from "@/lib/backup-ci/crypto";
import {
  BackupCiError,
  type PullRequestTarget,
  fetchDefinitionAt,
  fetchPullRequestTarget,
  installationTokenFor,
  isBackupCiBaseRef,
} from "@/lib/backup-ci/github";
import { evaluateActionsForPullRequest, isActionsMirrored, syncPullRequestCiGate } from "@/lib/backup-ci/gate-service";
import { db } from "@/lib/db";
import { isUniqueConstraintError } from "@/lib/prisma-error";

export { BACKUP_CI_BASE_REFS, BackupCiError } from "@/lib/backup-ci/github";

/**
 * バックアップCI（#4065）の起動・結果回収・共通チェックの発行。設計と運用手順は docs/backup-ci.md。
 *
 * - 起動は利用者の明示的な操作だけ（自動で障害を判定して切り替えない）
 * - 結果はWebhookで受け、取りこぼし・再起動はpollerの巡回（`sweepBackupCiRuns`）がAPIで照合して補う
 * - 合否はissue-deckの記録（`BackupCiRun`）と突き合わせてから共通チェックへ出す
 */

const RESULT_ARTIFACT_SUFFIX = "ci-result.json";
const CIRCLECI_WORKFLOW_NAME = "backup-ci";
const CIRCLECI_JOB_NAME = "required-checks";

// ---------------------------------------------------------------------------
// 設定

export type BackupCiReadiness = {
  setting: Pick<
    BackupCiSetting,
    "enabled" | "circleciProjectSlug" | "circleciDefinitionId" | "mirrorActionsToCiGate"
  > | null;
  tokenConfigured: boolean;
  webhookConfigured: boolean;
  /** 起動できない理由と、必要な操作（空なら起動できる） */
  problems: string[];
};

export async function getBackupCiReadiness(repositoryFullName: string): Promise<BackupCiReadiness> {
  const setting = await db.backupCiSetting.findUnique({ where: { repositoryFullName } });
  return describeReadiness(setting, {
    tokenConfigured: Boolean(process.env.CIRCLECI_API_TOKEN),
    webhookConfigured: Boolean(process.env.CIRCLECI_WEBHOOK_SECRET),
  });
}

export function describeReadiness(
  setting: BackupCiReadiness["setting"],
  env: { tokenConfigured: boolean; webhookConfigured: boolean },
): BackupCiReadiness {
  const problems: string[] = [];
  if (!setting?.enabled) problems.push("このリポジトリではバックアップCIが有効になっていません（下の設定で有効にしてください）。");
  if (!setting?.circleciProjectSlug) problems.push("CircleCIのプロジェクトスラッグが未設定です。");
  if (!setting?.circleciDefinitionId) problems.push("CircleCIのパイプライン定義IDが未設定です。");
  if (!env.tokenConfigured) problems.push("サーバーにCIRCLECI_API_TOKENが設定されていません（docs/backup-ci.md「初期設定」）。");
  // Webhookが無くても巡回のAPI照合で結果は回収できるため、起動は止めない（表示だけ）
  return { setting, ...env, problems };
}

export async function saveBackupCiSetting(input: {
  repositoryFullName: string;
  enabled: boolean;
  circleciProjectSlug: string | null;
  circleciDefinitionId: string | null;
  /** 省略時は変えない */
  mirrorActionsToCiGate?: boolean;
  userId: string;
}): Promise<BackupCiSetting> {
  const data = {
    enabled: input.enabled,
    ...(input.mirrorActionsToCiGate === undefined ? {} : { mirrorActionsToCiGate: input.mirrorActionsToCiGate }),
    circleciProjectSlug: input.circleciProjectSlug,
    circleciDefinitionId: input.circleciDefinitionId,
    updatedByUserId: input.userId,
  };
  return db.backupCiSetting.upsert({
    where: { repositoryFullName: input.repositoryFullName },
    create: { repositoryFullName: input.repositoryFullName, ...data },
    update: data,
  });
}

/** プロジェクトスラッグ・定義IDとして受け付ける形（URLへそのまま埋め込むため厳しめに絞る） */
export function isValidProjectSlug(value: string): boolean {
  return /^(?:gh|github|bb|circleci)\/[\w.-]+\/[\w.-]+$/.test(value);
}
export function isValidDefinitionId(value: string): boolean {
  return /^[0-9a-f-]{8,64}$/i.test(value);
}

function circleciClientOrThrow(): CircleciClient {
  const token = process.env.CIRCLECI_API_TOKEN;
  if (!token) throw new BackupCiError("not_configured", "サーバーにCIRCLECI_API_TOKENが設定されていません。");
  return createCircleciClient(token);
}

// ---------------------------------------------------------------------------
// 起動

export type StartBackupCiResult = { run: BackupCiRun; reused: boolean };

/**
 * PRに対してバックアップCIを1回起動する。
 *
 * **同じPRで未完了の実行があれば、新しく起動せずにそれを返す**（連打・再送・並行の操作で
 * 二重に採用しない。活性キーの一意制約で守る）。起動要求の応答が不明なら`trigger_unknown`で
 * 止め、確認せずに再送しない。
 */
export async function startBackupCiRun(input: {
  repositoryFullName: string;
  prNumber: number;
  userId: string;
}): Promise<StartBackupCiResult> {
  const { repositoryFullName, prNumber, userId } = input;
  const readiness = await getBackupCiReadiness(repositoryFullName);
  if (readiness.problems.length > 0) {
    throw new BackupCiError(readiness.setting?.enabled ? "not_configured" : "not_enabled", readiness.problems.join(" "));
  }
  const setting = readiness.setting!;
  const client = circleciClientOrThrow();
  const token = await installationTokenFor(repositoryFullName);

  const pr = await fetchPullRequestTarget(repositoryFullName, prNumber, token);
  if (pr.state !== "open") throw new BackupCiError("not_eligible", "openなPRだけが対象です。");
  if (!isBackupCiBaseRef(pr.baseRef)) {
    throw new BackupCiError("not_eligible", "バックアップCIの対象はdevelop向けPRだけです。");
  }
  if (pr.headRepoFullName !== repositoryFullName) {
    throw new BackupCiError("not_eligible", "フォークからのPRは対象外です。");
  }
  const definition = await fetchDefinitionAt(repositoryFullName, pr.baseSha, token);

  const activeKey = buildBackupCiActiveKey(repositoryFullName, prNumber);
  const existing = await db.backupCiRun.findUnique({ where: { activeKey } });
  if (existing) return { run: existing, reused: true };
  await refuseWhenActionsFailed(repositoryFullName, prNumber, pr, token);

  const last = await db.backupCiRun.findFirst({
    where: { repositoryFullName, prNumber },
    orderBy: { attempt: "desc" },
    select: { attempt: true },
  });
  let run: BackupCiRun;
  try {
    run = await db.backupCiRun.create({
      data: {
        repositoryFullName,
        prNumber,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        attempt: (last?.attempt ?? 0) + 1,
        status: "requesting",
        activeKey,
        startedByUserId: userId,
        definitionDigest: definition.digest,
      },
    });
  } catch (error) {
    // 同時に押された・試行番号が重なった。先に作られた方を返す
    if (isUniqueConstraintError(error)) {
      const winner = await db.backupCiRun.findUnique({ where: { activeKey } });
      if (winner) return { run: winner, reused: true };
    }
    throw error;
  }

  const triggered = await client.triggerPipeline({
    projectSlug: setting.circleciProjectSlug!,
    definitionId: setting.circleciDefinitionId!,
    configBranch: pr.baseRef,
    checkoutBranch: pr.headRef,
    parameters: {
      backup_ci: true,
      run_request_id: run.id,
      head_sha: pr.headSha,
      base_sha: pr.baseSha,
    },
  });

  if (triggered.kind === "created") {
    run = await db.backupCiRun.update({
      where: { id: run.id },
      data: {
        status: "running",
        externalPipelineId: triggered.pipelineId,
        externalPipelineNumber: triggered.pipelineNumber,
        triggeredAt: new Date(),
        logUrl: circleciWorkflowUrl(setting.circleciProjectSlug!, triggered.pipelineNumber, null),
      },
    });
  } else {
    run = await db.backupCiRun.update({
      where: { id: run.id },
      data: {
        status: triggered.kind === "rejected" ? "trigger_failed" : "trigger_unknown",
        statusReason:
          triggered.kind === "unknown"
            ? `${triggered.reason}。CircleCI側で起動している可能性があるため、自動では再送しません。CircleCIの画面で確認してから、必要なら再実行してください。`
            : triggered.reason,
        activeKey: null,
        completedAt: new Date(),
      },
    });
  }
  await syncPullRequestCiGate({ repositoryFullName, prNumber, pr, token });
  return { run, reused: false };
}

/**
 * 通常時もActionsの結果を写しているリポジトリで、**今のheadに対してActionsの必須ジョブが失敗で
 * 終わっている**なら起動しない（#4113）。バックアップCIは「Actionsが動かない」ときの代替で、
 * 検査の失敗を別のCIで上書きする経路にしない（キャンセル・未開始・検査中は障害の可能性があるので止めない）。
 */
async function refuseWhenActionsFailed(
  repositoryFullName: string,
  prNumber: number,
  pr: PullRequestTarget,
  token: string,
): Promise<void> {
  if (!(await isActionsMirrored(repositoryFullName))) return;
  const actions = await evaluateActionsForPullRequest(repositoryFullName, prNumber, pr, token);
  if (actions.decision.state === "failure") {
    throw new BackupCiError(
      "not_eligible",
      `GitHub Actionsがこのコミットの検査を失敗で終えています（${actions.decision.description}）。障害ではなく検査の失敗なので、直してpushするか、Actionsで再実行してください。`,
    );
  }
}

// ---------------------------------------------------------------------------
// 結果の回収

/** 1件の実行をCircleCI・GitHubと照合して状態を進める。Webhook・巡回の両方から呼ぶ */
export async function reconcileBackupCiRun(run: BackupCiRun, now = new Date()): Promise<BackupCiRun> {
  const status = parseBackupCiRunStatus(run.status);
  if (!status) return run;
  const token = await installationTokenFor(run.repositoryFullName);
  const pr = await fetchPullRequestTarget(run.repositoryFullName, run.prNumber, token);
  const current = { headSha: pr.headSha, baseSha: pr.baseSha };

  let next = run;
  if (status === "requesting" && now.getTime() - run.requestedAt.getTime() > BACKUP_CI_REQUESTING_STALE_MS) {
    // 起動処理の途中でプロセスが落ちた。CircleCI側で起動したかは分からないので再送しない
    next = await finish(run, "trigger_unknown", "起動処理が完了しないまま中断しました（再起動など）。CircleCIの画面で確認してから再実行してください。");
  } else if (status === "running") {
    next = await collectRunningResult(run, now);
  }

  // 実行中・合格のあとでPRが更新されたら、その結果は使わない
  const latest = parseBackupCiRunStatus(next.status);
  if (
    latest &&
    (latest === "running" || latest === "passed") &&
    (next.headSha !== current.headSha || next.baseSha !== current.baseSha || pr.state !== "open")
  ) {
    next = await finish(next, "superseded", "PRのhead/baseが更新されたため、この結果は採用しません。再実行してください。");
  }
  next = await db.backupCiRun.update({ where: { id: next.id }, data: { lastReconciledAt: now } });
  if (pr.state === "open") {
    await syncPullRequestCiGate({ repositoryFullName: run.repositoryFullName, prNumber: run.prNumber, pr, token, now });
  }
  return next;
}

async function collectRunningResult(run: BackupCiRun, now: Date): Promise<BackupCiRun> {
  const setting = await db.backupCiSetting.findUnique({ where: { repositoryFullName: run.repositoryFullName } });
  const slug = setting?.circleciProjectSlug;
  const startedAt = run.triggeredAt ?? run.requestedAt;
  const timedOut = now.getTime() - startedAt.getTime() > BACKUP_CI_RUN_TIMEOUT_MS;
  if (!slug || !run.externalPipelineId) {
    return finish(run, "unverifiable", "CircleCIのプロジェクト設定またはパイプラインIDが無いため、結果を確認できません。");
  }
  const client = circleciClientOrThrow();
  const workflows = await client.getPipelineWorkflows(run.externalPipelineId);
  const workflow = workflows.find((w) => w.name === CIRCLECI_WORKFLOW_NAME) ?? null;
  if (!workflow) {
    return timedOut
      ? finish(run, "unverifiable", "時間内にCircleCIのワークフローが作られませんでした（設定の読み込み失敗の可能性があります）。")
      : run;
  }
  const logUrl = circleciWorkflowUrl(slug, run.externalPipelineNumber, workflow.id);
  if (!isCircleciWorkflowTerminal(workflow.status)) {
    if (timedOut) return finish(run, "unverifiable", "時間切れです（90分以内に完了しませんでした）。", { externalWorkflowId: workflow.id, logUrl });
    return db.backupCiRun.update({ where: { id: run.id }, data: { externalWorkflowId: workflow.id, logUrl } });
  }
  if (workflow.status === "canceled" || workflow.status === "not_run" || workflow.status === "unauthorized") {
    return finish(run, "unverifiable", `CircleCIのワークフローが完了しませんでした（${workflow.status}）。`, {
      externalWorkflowId: workflow.id,
      logUrl,
    });
  }

  const jobs = await client.getWorkflowJobs(workflow.id);
  const job = jobs.find((j) => j.name === CIRCLECI_JOB_NAME) ?? null;
  const token = await installationTokenFor(run.repositoryFullName);
  const definition = await fetchDefinitionAt(run.repositoryFullName, run.baseSha, token);
  let result: unknown = null;
  if (job?.jobNumber != null) {
    const artifacts = await client.getJobArtifacts(slug, job.jobNumber);
    const artifact = artifacts.find((a) => a.path.endsWith(RESULT_ARTIFACT_SUFFIX));
    if (artifact) result = await client.downloadJson(artifact.url);
  }
  const verdict = evaluateBackupCiResult({
    run,
    expectedChecks: definition.checks,
    jobSucceeded: workflow.status === "success" && job?.status === "success",
    result,
  });
  const common = {
    externalWorkflowId: workflow.id,
    externalJobNumber: job?.jobNumber ?? null,
    logUrl,
    checksJson: JSON.stringify(verdict.checks),
  };
  if (verdict.status === "passed") {
    return finish(run, "passed", null, {
      ...common,
      testedSha: verdict.testedSha,
      testedParents: verdict.testedParents.join(","),
      resultDigest: verdict.resultDigest,
    });
  }
  return finish(run, verdict.status, verdict.reason, common);
}

function finish(
  run: BackupCiRun,
  status: BackupCiRunStatus,
  reason: string | null,
  extra: Partial<BackupCiRun> = {},
): Promise<BackupCiRun> {
  return db.backupCiRun.update({
    where: { id: run.id },
    data: { ...extra, status, statusReason: reason, activeKey: null, completedAt: run.completedAt ?? new Date() },
  });
}

// ---------------------------------------------------------------------------
// Webhook・巡回

export type CircleciWebhookOutcome =
  | { kind: "unauthorized" }
  | { kind: "not_configured" }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "ignored" }
  | { kind: "processed"; runId: string; status: string };

/**
 * CircleCIの完了Webhookを処理する。**署名を検証してから**イベントIDで重複を除き、該当する実行を
 * APIで照合し直す（Webhookの本文の状態は信じず、合否はAPIの結果と記録の突き合わせで決める）。
 */
export async function handleCircleciWebhook(rawBody: string, signature: string | null): Promise<CircleciWebhookOutcome> {
  const secret = process.env.CIRCLECI_WEBHOOK_SECRET;
  if (!secret) return { kind: "not_configured" };
  if (!verifyCircleciSignature(rawBody, signature, secret)) return { kind: "unauthorized" };
  const event = parseCircleciWebhook(safeJson(rawBody));
  if (!event) return { kind: "invalid" };
  try {
    await db.circleciWebhookDelivery.create({ data: { eventId: event.eventId, type: event.type } });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { kind: "duplicate" };
    throw error;
  }
  try {
    if (!event.pipelineId) return { kind: "ignored" };
    const run = await db.backupCiRun.findUnique({ where: { externalPipelineId: event.pipelineId } });
    if (!run) return { kind: "ignored" };
    const next = await reconcileBackupCiRun(run);
    return { kind: "processed", runId: next.id, status: next.status };
  } catch (error) {
    // 処理に失敗したイベントは、再送で受け直せるよう台帳から外す
    await db.circleciWebhookDelivery.delete({ where: { eventId: event.eventId } }).catch(() => undefined);
    throw error;
  }
}

/** 合格の後もPRの更新を見張る期間。これより古い合格は照合しない */
const PASSED_WATCH_MS = 3 * 24 * 60 * 60 * 1000;
const PASSED_RECHECK_MS = 3 * 60 * 1000;
const WEBHOOK_DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * pollerの巡回で呼ぶ。Webhookの欠落・issue-deckの再起動で止まった実行をAPI照合で進め、
 * 合格済みの実行はPRのhead/base更新を検出して無効にする。
 */
export async function sweepBackupCiRuns(now = new Date()): Promise<{ checked: number; errors: number }> {
  // 複数のpollerが同時に叩いても、このプロセスで重ねて照合しない
  if (sweepInFlight) return { checked: 0, errors: 0 };
  sweepInFlight = true;
  try {
    return await sweepBackupCiRunsOnce(now);
  } finally {
    sweepInFlight = false;
  }
}

let sweepInFlight = false;

async function sweepBackupCiRunsOnce(now: Date): Promise<{ checked: number; errors: number }> {
  const runs = await db.backupCiRun.findMany({
    where: {
      OR: [
        { status: { in: ["requesting", "running"] } },
        {
          status: "passed",
          completedAt: { gte: new Date(now.getTime() - PASSED_WATCH_MS) },
          // 合格の見張りは数分おきで足りる（巡回は30秒ごと。GitHub APIを無駄に使わない）
          OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lt: new Date(now.getTime() - PASSED_RECHECK_MS) } }],
        },
      ],
    },
    orderBy: { lastReconciledAt: "asc" },
    take: 20,
  });
  let errors = 0;
  for (const run of runs) {
    try {
      await reconcileBackupCiRun(run, now);
    } catch (error) {
      errors += 1;
      console.error(`[backup-ci] 照合に失敗しました ${run.repositoryFullName}#${run.prNumber} (${run.id}):`, error);
    }
  }
  await db.circleciWebhookDelivery
    .deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_MS) } } })
    .catch(() => undefined);
  return { checked: runs.length, errors };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
