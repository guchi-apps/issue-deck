import type { DeployRecoverySeries } from "@prisma/client";

import { parseClaudeLocalModel, parseCodexLocalModel, resolveAiExecutionAgent } from "@/lib/app-settings";
import { tailDeployLog } from "@/lib/claude/deploy-failure-analysis";
import { db } from "@/lib/db";
import { enqueueDispatchJob } from "@/lib/dispatch/jobs";
import { buildDeployRecoveryIssueSection, DEPLOY_FAILURE_FIX_TITLE_PREFIX } from "@/lib/deploy-failure";
import {
  decideDeployRecovery,
  DEPLOY_RECOVERY_CAUSE_MARKER_PREFIX,
  DEPLOY_RECOVERY_PREPARING_TIMEOUT_MS,
  DEPLOY_RECOVERY_SCOPE,
  DEPLOY_RECOVERY_TTL_MS,
  deployRecoveryRoundsUsed,
  deployRecoverySeriesMarker,
  deployRecoveryStatusLabel,
  deployRecoveryStopReasonLabel,
  isDeployRecoveryActive,
  parseDeployRecoveryCause,
  type DeployRecoveryCause,
  type DeployRecoveryDecision,
  type DeployRecoveryStatus,
} from "@/lib/deploy-recovery-series";
import { fetchWorkflowJobLogs, fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import {
  addIssueLabels,
  createComment,
  createIssue,
  fetchCommentsForIssue,
  fetchOpenIssuesForRepo,
} from "@/lib/github/issues-api";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { enrollPullRequestAutoRepairLoop } from "@/lib/github/pull-request-auto-repair-start";
import { fetchLatestDeployWorkflowRun, fetchPackageVersion } from "@/lib/github/release-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { isTrustedGithubAuthor } from "@/lib/github/trusted-author";
import { isUniqueConstraintError } from "@/lib/prisma-error";

/**
 * 本番デプロイ失敗からの復旧系列（#3998）の外部操作。判断は`deploy-recovery-series.ts`の純関数が持つ。
 *
 * **再起動しても続きから進められる形にする。** 進行はすべてDBの行（`DeployRecoverySeries`）に置き、
 * 外部操作の前後で記録する。記録に失敗して同じ操作をやり直しても重複しないよう、修正Issueは本文の
 * マーカーで探し直し、dispatchは`DispatchJob.activeKey`の二重起動防止に任せる。
 */

const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";
const SWEEP_INTERVAL_MS = 30 * 1000;
const LOG_EXCERPT_MAX_LENGTH = 3000;
const CHECK_USER_LABELS = ["00.check-user", "01.check-blocked"];
const MERGE_CONFIRM_LABEL = "22.merge-confirm-required";

type SeriesRow = DeployRecoverySeries;

export type DeployRecoverySeriesView = {
  id: string;
  repositoryFullName: string;
  status: string;
  statusLabel: string;
  active: boolean;
  failedRunId: number;
  failedRunAttempt: number;
  failedRunUrl: string;
  failedSha: string;
  scope: string;
  expiresAt: string;
  issueNumber: number | null;
  pullRequestNumber: number | null;
  cause: string | null;
  repairRoundsUsed: number;
  stopReason: string | null;
  stopMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toDeployRecoverySeriesView(row: SeriesRow): DeployRecoverySeriesView {
  return {
    id: row.id,
    repositoryFullName: row.repositoryFullName,
    status: row.status,
    statusLabel: deployRecoveryStatusLabel(row.status),
    active: isDeployRecoveryActive(row.status),
    failedRunId: Number(row.failedRunId),
    failedRunAttempt: row.failedRunAttempt,
    failedRunUrl: row.failedRunUrl,
    failedSha: row.failedSha,
    scope: row.scope,
    expiresAt: row.expiresAt.toISOString(),
    issueNumber: row.issueNumber,
    pullRequestNumber: row.pullRequestNumber,
    cause: row.cause,
    repairRoundsUsed: row.repairRoundsUsed,
    stopReason: row.stopReason,
    stopMessage: deployRecoveryStopReasonLabel(row.stopReason, row.stopDetail),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function splitFullName(fullName: string): [string, string] {
  const [owner, repo] = fullName.split("/");
  return [owner ?? "", repo ?? ""];
}

async function requestJson<T>(url: string, token: string): Promise<T> {
  const response = await githubFetch(url, token);
  if (!response.ok) {
    throw new GithubApiError(response.status, `GitHub API request failed: ${response.status} ${url}`);
  }
  return response.json();
}

type GithubWorkflowRun = {
  id: number;
  path?: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  head_branch: string | null;
  run_attempt?: number;
};

export type StartDeployRecoveryResult =
  | { ok: true; series: DeployRecoverySeriesView; created: boolean }
  | { ok: false; error: "deploy_not_failed" | "not_latest_failure" | "series_active"; series?: DeployRecoverySeriesView };

/**
 * 「AIに修正を依頼」の開始（#3998）。**対象の失敗はサーバーがGitHubから読み直す。** 画面が送るのは
 * run idだけで、それが`deploy.yml`の最新の実行であり、失敗していることをここで確かめる。
 *
 * 同じ失敗（run・attempt）で押し直しても同じ系列を返す。同じリポジトリで別の系列が進行中なら
 * 新しく始めない（`activeKey`の一意制約で原子的に弾く）。修正Issueの作成と実装の起動は、
 * 次のpollerの巡回（`runDeployRecoverySweep`）が行う。
 */
export async function startDeployRecoverySeries(params: {
  repositoryFullName: string;
  runId: number;
  userId: string;
  token: string;
  now?: Date;
}): Promise<StartDeployRecoveryResult> {
  const now = params.now ?? new Date();
  const [owner, repo] = splitFullName(params.repositoryFullName);
  const run = await requestJson<GithubWorkflowRun>(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${params.runId}`,
    params.token,
  );
  if (
    run.path?.split("@")[0] !== DEPLOY_WORKFLOW_PATH ||
    run.status !== "completed" ||
    (run.conclusion !== "failure" && run.conclusion !== "timed_out")
  ) {
    return { ok: false, error: "deploy_not_failed" };
  }
  // 古い失敗から始めない。すでに後続の実行が成功・進行していれば、その失敗は直す対象ではない。
  const latest = await fetchLatestDeployWorkflowRun(owner, repo, params.token);
  if (latest?.id !== run.id) return { ok: false, error: "not_latest_failure" };

  const failureKey = {
    repositoryFullName: params.repositoryFullName,
    environment: "production",
    failedRunId: BigInt(run.id),
    failedRunAttempt: run.run_attempt ?? 1,
  };
  const existing = await db.deployRecoverySeries.findUnique({
    where: { repositoryFullName_environment_failedRunId_failedRunAttempt: failureKey },
  });
  if (existing) return { ok: true, series: toDeployRecoverySeriesView(existing), created: false };

  const failedVersion = await fetchPackageVersion(owner, repo, run.head_sha, params.token).catch(() => null);
  try {
    const created = await db.deployRecoverySeries.create({
      data: {
        ...failureKey,
        failedSha: run.head_sha,
        failedRunUrl: run.html_url,
        failedVersion,
        status: "starting",
        activeKey: params.repositoryFullName,
        startedByUserId: params.userId,
        scope: DEPLOY_RECOVERY_SCOPE,
        expiresAt: new Date(now.getTime() + DEPLOY_RECOVERY_TTL_MS),
      },
    });
    return { ok: true, series: toDeployRecoverySeriesView(created), created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // 同時押しで同じ失敗の行が先にできた場合と、別の失敗の系列が進行中の場合の2通り。
    const same = await db.deployRecoverySeries.findUnique({ where: { repositoryFullName_environment_failedRunId_failedRunAttempt: failureKey } });
    if (same) return { ok: true, series: toDeployRecoverySeriesView(same), created: false };
    const active = await db.deployRecoverySeries.findUnique({ where: { activeKey: params.repositoryFullName } });
    return { ok: false, error: "series_active", series: active ? toDeployRecoverySeriesView(active) : undefined };
  }
}

/** リポジトリの直近の系列（画面表示用）。 */
export async function findLatestDeployRecoverySeries(repositoryFullName: string): Promise<DeployRecoverySeriesView | null> {
  const row = await db.deployRecoverySeries.findFirst({
    where: { repositoryFullName },
    orderBy: { createdAt: "desc" },
  });
  return row ? toDeployRecoverySeriesView(row) : null;
}

/**
 * 停止（#3998）。**以後この系列から新しい修復・マージ・デプロイを始めない。**
 *
 * 動いている実装セッションやworkflowは取り消せないので、画面にはその旨を出す。修正PRがdevelopへ
 * 自動マージされないよう修正Issueへ`22.merge-confirm-required`を付け、PRの自動修復系列も止める。
 */
export async function stopDeployRecoverySeries(params: {
  repositoryFullName: string;
  seriesId: string;
  userId: string;
  token: string;
  now?: Date;
}): Promise<DeployRecoverySeriesView | null> {
  const now = params.now ?? new Date();
  const row = await db.deployRecoverySeries.findFirst({
    where: { id: params.seriesId, repositoryFullName: params.repositoryFullName },
  });
  if (!row) return null;
  if (!isDeployRecoveryActive(row.status)) return toDeployRecoverySeriesView(row);
  await db.deployRecoverySeries.updateMany({
    where: { id: row.id, status: row.status },
    data: {
      status: "stopped",
      activeKey: null,
      stopReason: "stopped_by_user",
      stoppedByUserId: params.userId,
      stoppedAt: now,
    },
  });
  if (row.pullRequestNumber !== null) {
    await db.pullRequestAutoRepairLoop.updateMany({
      where: {
        repositoryFullName: row.repositoryFullName,
        pullRequestNumber: row.pullRequestNumber,
        status: "running",
      },
      data: { status: "stopped", currentKind: null, stopReason: "stopped_by_user" },
    });
  }
  if (row.issueNumber !== null) {
    const [owner, repo] = splitFullName(row.repositoryFullName);
    await addIssueLabels(owner, repo, row.issueNumber, params.token, [MERGE_CONFIRM_LABEL]).catch((error: unknown) => {
      console.error("[stopDeployRecoverySeries] マージ前確認ラベルを付けられませんでした", row.id, error);
    });
  }
  const updated = await db.deployRecoverySeries.findUnique({ where: { id: row.id } });
  return updated ? toDeployRecoverySeriesView(updated) : null;
}

export type DeployRecoverySweepAction = {
  seriesId: string;
  repositoryFullName: string;
  action: string;
  detail?: string;
};

/**
 * pollerから呼ぶ1巡（#3998）。進行中の系列ごとに、実行権を取ってから観測→判断→適用する。
 * `hostName`は呼んだpollerのホストで、修正の実装はそこで起動する。
 */
export async function runDeployRecoverySweep(params: {
  hostName: string;
  now?: Date;
}): Promise<{ scanned: number; actions: DeployRecoverySweepAction[] }> {
  const now = params.now ?? new Date();
  // 準備中に落ちた系列は準備からやり直す。修正Issueはマーカーで探し直し、dispatchは
  // `activeKey`が二重起動を弾くため、やり直しても重複しない。
  await db.deployRecoverySeries.updateMany({
    where: { status: "preparing", updatedAt: { lt: new Date(now.getTime() - DEPLOY_RECOVERY_PREPARING_TIMEOUT_MS) } },
    data: { status: "starting" },
  });
  const rows = await db.deployRecoverySeries.findMany({ where: { activeKey: { not: null } } });
  const actions: DeployRecoverySweepAction[] = [];

  for (const stored of rows) {
    // 準備中の行には触れない（触ると`updatedAt`が進み、上の「準備中に落ちた」判定が効かなくなる）。
    if (stored.status === "preparing") continue;
    try {
      // 複数のpollerが同時に来ても1本だけが進める。GitHub APIの消費も系列ごとに30秒に1回へ抑える。
      const claim = await db.deployRecoverySeries.updateMany({
        where: {
          id: stored.id,
          status: stored.status,
          OR: [{ lastSweepAt: null }, { lastSweepAt: { lt: new Date(now.getTime() - SWEEP_INTERVAL_MS) } }],
        },
        data: { lastSweepAt: now },
      });
      if (claim.count !== 1) continue;
      const action = await advanceSeries(stored, params.hostName, now);
      if (action) actions.push({ seriesId: stored.id, repositoryFullName: stored.repositoryFullName, ...action });
    } catch (error) {
      // 1本の障害で他の系列を止めない。次の巡回で再評価する。
      console.error("[runDeployRecoverySweep]", stored.repositoryFullName, stored.id, error);
    }
  }
  return { scanned: rows.length, actions };
}

async function advanceSeries(
  series: SeriesRow,
  hostName: string,
  now: Date,
): Promise<{ action: string; detail?: string } | null> {
  const repository = await db.repository.findFirst({
    where: { fullName: series.repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return null;
  const token = await getInstallationToken(repository.installation.installationId);

  if (series.status === "starting" && now < series.expiresAt) {
    const claimed = await db.deployRecoverySeries.updateMany({
      where: { id: series.id, status: "starting" },
      data: { status: "preparing" },
    });
    if (claimed.count !== 1) return null;
    return prepareSeries(series, token, hostName, now);
  }

  const observation = await observeSeries(series, token);
  const decision = decideDeployRecovery(
    {
      status: series.status as DeployRecoveryStatus,
      expiresAt: series.expiresAt,
      dispatchedAt: series.dispatchedAt,
      cause: series.cause as DeployRecoveryCause | null,
      pullRequestNumber: series.pullRequestNumber,
      repairRoundsBase: series.repairRoundsBase,
    },
    { now, ...observation },
  );
  const roundsUsed = deployRecoveryRoundsUsed(series, observation.repairLoop);
  if (roundsUsed !== series.repairRoundsUsed) {
    await db.deployRecoverySeries.update({ where: { id: series.id }, data: { repairRoundsUsed: roundsUsed } });
  }
  return applyDecision(series, decision, token, observation.pullRequest?.headSha ?? null);
}

async function observeSeries(series: SeriesRow, token: string) {
  const [owner, repo] = splitFullName(series.repositoryFullName);
  let reportedCause: DeployRecoveryCause | null = null;
  if (series.status === "investigating" && series.issueNumber !== null) {
    const since = series.dispatchedAt ?? series.createdAt;
    const comments = await fetchCommentsForIssue(owner, repo, series.issueNumber, token);
    // 公開リポジトリでは誰でもコメントできるため、マーカーを読むのは信頼できる投稿者だけにする。
    reportedCause = parseDeployRecoveryCause(
      comments
        .filter((comment) => new Date(comment.created_at) >= since)
        // 指示文（区分のマーカーを例として全部含む）を報告と読み違えない。
        .filter((comment) => !comment.body?.includes("issue-deck-deploy-recovery-series:"))
        .filter((comment) =>
          isTrustedGithubAuthor({ login: comment.user?.login ?? "", association: comment.author_association ?? null }),
        )
        .map((comment) => comment.body),
    );
  }

  let pullRequest: { number: number; state: "open" | "closed"; merged: boolean; headSha: string } | null = null;
  let repairLoop: { status: string; round: number; stopReason: string | null } | null = null;
  if ((series.status === "fixing" || series.status === "awaiting_checks") && series.issueNumber !== null) {
    const pulls = await requestJson<
      Array<{ number: number; state: string; merged_at: string | null; head: { sha: string }; created_at: string }>
    >(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=all&base=develop&head=${encodeURIComponent(`${owner}:issue-${series.issueNumber}`)}&sort=created&direction=desc&per_page=10`,
      token,
    );
    // 系列より前に閉じられたPR（同じIssueの過去の修正）は数えない。
    const candidate =
      (series.pullRequestNumber !== null ? pulls.find((pull) => pull.number === series.pullRequestNumber) : undefined) ??
      pulls.find((pull) => new Date(pull.created_at) >= series.createdAt);
    if (candidate) {
      pullRequest = {
        number: candidate.number,
        state: candidate.state === "closed" ? "closed" : "open",
        merged: candidate.merged_at !== null,
        headSha: candidate.head.sha,
      };
      const loop = await db.pullRequestAutoRepairLoop.findUnique({
        where: {
          repositoryFullName_pullRequestNumber: {
            repositoryFullName: series.repositoryFullName,
            pullRequestNumber: candidate.number,
          },
        },
      });
      // 系列の開始より前に終わっていた修復系列は、この系列の修復ではない。
      repairLoop = loop && loop.updatedAt >= series.createdAt ? { status: loop.status, round: loop.round, stopReason: loop.stopReason } : null;
    }
  }
  return { reportedCause, pullRequest, repairLoop };
}

async function applyDecision(
  series: SeriesRow,
  decision: DeployRecoveryDecision,
  token: string,
  pullRequestHeadSha: string | null,
): Promise<{ action: string; detail?: string } | null> {
  if (decision.action === "wait") return null;

  if (decision.action === "enroll_repair") {
    if (pullRequestHeadSha === null) return null;
    await enrollPullRequestAutoRepairLoop({
      repositoryFullName: series.repositoryFullName,
      pullRequestNumber: decision.pullRequestNumber,
      headSha: pullRequestHeadSha,
      maxRounds: decision.maxRounds,
    });
    return { action: "enroll_repair", detail: `#${decision.pullRequestNumber}` };
  }

  if (decision.action === "transition") {
    const terminal = !isDeployRecoveryActive(decision.status);
    const updated = await db.deployRecoverySeries.updateMany({
      where: { id: series.id, status: series.status },
      data: {
        status: decision.status,
        ...(decision.cause ? { cause: decision.cause } : {}),
        ...(decision.pullRequestNumber !== undefined ? { pullRequestNumber: decision.pullRequestNumber } : {}),
        ...(terminal ? { activeKey: null } : {}),
      },
    });
    if (updated.count === 1 && decision.status === "awaiting_release") {
      await notifyHandOff(
        series,
        token,
        [
          `修正PR #${series.pullRequestNumber ?? "?"} がdevelopへマージされました。**本番（main）へはまだ出ていません。**`,
          "",
          "この段階の自動化はここまでです（mainへの限定反映・再デプロイ・稼働版の確認は #4005〜#4007 で追加予定）。",
          "デプロイ失敗の帯の「既存の修正PRを選んで復旧」でこのPRだけをmainへ出すか、通常のリリースで反映してください。",
        ].join("\n"),
      );
    }
    return { action: `transition:${decision.status}` };
  }

  // stop
  const updated = await db.deployRecoverySeries.updateMany({
    where: { id: series.id, status: series.status },
    data: { status: "needs_attention", activeKey: null, stopReason: decision.reason, stopDetail: decision.detail ?? null },
  });
  if (updated.count === 1) {
    if (series.pullRequestNumber !== null) {
      await db.pullRequestAutoRepairLoop.updateMany({
        where: { repositoryFullName: series.repositoryFullName, pullRequestNumber: series.pullRequestNumber, status: "running" },
        data: { status: "stopped", currentKind: null, stopReason: "stopped_by_user" },
      });
    }
    await notifyHandOff(
      series,
      token,
      `本番復旧の自動化を止めました。${deployRecoveryStopReasonLabel(decision.reason, decision.detail ?? null) ?? ""}`,
    );
  }
  return { action: `stop:${decision.reason}`, detail: decision.detail };
}

/**
 * 人へ渡すときの通知。修正Issueへコメントし、`00.check-user`＋理由ラベルでPush通知を鳴らす。
 * 状態が変わったとき（`updateMany`で1件だけ更新できたとき）にだけ呼ぶので重複しない。
 */
async function notifyHandOff(series: SeriesRow, token: string, message: string): Promise<void> {
  if (series.issueNumber === null) return;
  const [owner, repo] = splitFullName(series.repositoryFullName);
  try {
    await createComment(owner, repo, series.issueNumber, token, {
      body: `${message}\n\n- 失敗した実行: ${series.failedRunUrl}\n\n<!-- issue-deck-agent:guide -->`,
    });
    await addIssueLabels(owner, repo, series.issueNumber, token, CHECK_USER_LABELS);
  } catch (error) {
    console.error("[deploy-recovery] 引き継ぎの通知に失敗しました", series.id, error);
  }
}

/** 修正Issueを用意し（探す→再利用→作成）、実装を起動する。 */
async function prepareSeries(
  series: SeriesRow,
  token: string,
  hostName: string,
  now: Date,
): Promise<{ action: string; detail?: string }> {
  const [owner, repo] = splitFullName(series.repositoryFullName);
  const marker = deployRecoverySeriesMarker(series.id);

  let issueNumber = series.issueNumber;
  if (issueNumber === null) {
    const section = await buildIssueSection(series, token, marker);
    const openIssues = await fetchOpenIssuesForRepo(owner, repo, token);
    // 記録に失敗してやり直した場合は、自分のマーカー入りのIssueがあるはず。
    const own = openIssues.find((issue) => issue.body?.includes(marker));
    // 人が帯の「修正Issueを作成」で先に立てたものがあれば増やさずに使う（他の系列が使っていないもの）。
    const reusable =
      own ??
      [...openIssues]
        .reverse()
        .find(
          (issue) =>
            issue.title.startsWith(DEPLOY_FAILURE_FIX_TITLE_PREFIX) &&
            !issue.body?.includes("issue-deck-deploy-recovery-series:"),
        );
    if (own) {
      issueNumber = own.number;
    } else if (reusable) {
      issueNumber = reusable.number;
      await createComment(owner, repo, reusable.number, token, { body: section });
    } else {
      const versionPart = series.failedVersion ? `v${series.failedVersion}の` : "";
      const created = await createIssue(owner, repo, token, {
        title: `${DEPLOY_FAILURE_FIX_TITLE_PREFIX} ${versionPart}本番デプロイが失敗する原因を直す`,
        body: section,
      });
      issueNumber = created.number;
    }
    await db.deployRecoverySeries.update({ where: { id: series.id }, data: { issueNumber } });
  }

  const setting = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { defaultDispatchAgent: true, aiExecutionProvider: true, claudeLocalModel: true, codexModel: true },
  });
  const enqueued = await enqueueDispatchJob({
    repositoryFullName: series.repositoryFullName,
    issueNumber,
    hostName,
    agent: resolveAiExecutionAgent(setting?.defaultDispatchAgent, setting?.aiExecutionProvider),
    claudeModel: parseClaudeLocalModel(setting?.claudeLocalModel),
    codexModel: parseCodexLocalModel(setting?.codexModel),
    requestedByUserId: series.startedByUserId,
    now,
  });
  // 起動済み（記録に失敗したやり直しでは自分の起動が残っている）は成功として進める。
  const alreadyRunning = !enqueued.ok && (enqueued.rejection === "already_queued" || enqueued.rejection === "session_alive");
  if (!enqueued.ok && !alreadyRunning) {
    if (enqueued.rejection === "agent_paused" || enqueued.rejection === "host_offline") {
      // 一時的な理由は次の巡回でやり直す（期限を過ぎれば止まる）。
      await db.deployRecoverySeries.updateMany({ where: { id: series.id, status: "preparing" }, data: { status: "starting" } });
      return { action: "deferred", detail: enqueued.message };
    }
    await db.deployRecoverySeries.updateMany({
      where: { id: series.id, status: "preparing" },
      data: { status: "needs_attention", activeKey: null, stopReason: "dispatch_failed", stopDetail: enqueued.message },
    });
    await notifyHandOff({ ...series, issueNumber }, token, `本番復旧の自動化を止めました。実装を起動できませんでした（${enqueued.message}）。`);
    return { action: "stop:dispatch_failed", detail: enqueued.message };
  }
  await db.deployRecoverySeries.updateMany({
    where: { id: series.id, status: "preparing" },
    data: {
      status: "investigating",
      dispatchedAt: now,
      ...(enqueued.ok ? { dispatchJobId: enqueued.job.id } : {}),
    },
  });
  await addIssueLabels(owner, repo, issueNumber, token, [LOCAL_LABEL_NAME]).catch((error: unknown) => {
    console.error("[deploy-recovery] 11.localを付けられませんでした", series.id, error);
  });
  return { action: "dispatched", detail: `#${issueNumber}` };
}

/** 修正Issueに書く引き継ぎ情報。ログ・失敗工程・直近の成功版はここで読み直す（失敗しても本文は作る）。 */
async function buildIssueSection(series: SeriesRow, token: string, marker: string): Promise<string> {
  const [owner, repo] = splitFullName(series.repositoryFullName);
  const runId = Number(series.failedRunId);
  let failedJobs: string[] = [];
  let logExcerpt: string | null = null;
  try {
    const jobs = await fetchWorkflowRunJobs(owner, repo, runId, token);
    const failed = jobs.filter((job) => job.conclusion === "failure" && typeof job.id === "number");
    failedJobs = failed.map((job) => job.name ?? "不明");
    if (failed[0]) {
      // ログは公開リポジトリのIssueに載るため、秘密値になりうる文字列を伏せてから載せる。
      logExcerpt = tailDeployLog(await fetchWorkflowJobLogs(owner, repo, failed[0].id as number, token), LOG_EXCERPT_MAX_LENGTH);
    }
  } catch (error) {
    console.error("[deploy-recovery] 失敗したジョブのログを読めませんでした", series.id, error);
  }
  let runningSha: string | null = null;
  try {
    const success = await requestJson<{ workflow_runs?: Array<{ head_sha: string }> }>(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/deploy.yml/runs?status=success&per_page=1`,
      token,
    );
    runningSha = success.workflow_runs?.[0]?.head_sha ?? null;
  } catch (error) {
    console.error("[deploy-recovery] 直近の成功したデプロイを読めませんでした", series.id, error);
  }
  return buildDeployRecoveryIssueSection({
    seriesMarker: marker,
    failedSha: series.failedSha,
    failedRunUrl: series.failedRunUrl,
    failedRunAttempt: series.failedRunAttempt,
    failedJobs,
    runningSha,
    logExcerpt,
    causeMarkerPrefix: DEPLOY_RECOVERY_CAUSE_MARKER_PREFIX,
  });
}
