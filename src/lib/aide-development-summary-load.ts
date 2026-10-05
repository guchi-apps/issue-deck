import {
  buildDevelopmentSummary,
  type DeployEvidence,
  type DevelopmentSummary,
  type ReservationRow,
} from "@/lib/aide-development-summary";
import { db } from "@/lib/db";
import { listDispatchState } from "@/lib/dispatch/jobs";
import { getInstallationToken } from "@/lib/github/app-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { fetchLatestDeployWorkflowRun } from "@/lib/github/release-api";
import { getIssuesForUser } from "@/lib/issues-for-user";
import { peekClaudeWindowSnapshot, readNextWindowRunSettings } from "@/lib/next-window-run-db";
import { resolveNextWindowRunWindow, toNextWindowRunWindowView } from "@/lib/next-window-run";
import { fetchPullRequestListForUser } from "@/lib/pull-request-list-fetch";
import { buildSnoozeMap, type SnoozeEntry } from "@/lib/snooze";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * AIDE向け開発状況サマリ（#3999）の材料を**読み取り専用**で集める。
 *
 * 禁止していること（呼び出しても状態が変わるもの）:
 * - ジョブの起動・予約の変更・既読化・AI推論
 * - 5時間枠の取得（`readClaudeWindowSnapshot`は推論リクエスト1本で枠を開始する）。メモリ上の最後に
 *   見た値（`peekClaudeWindowSnapshot`）だけを読む
 * - 停滞ジョブのTIMEOUT確定・期限切れ要求の掃除（`listDispatchState`の`sweepExpired: false`）
 *
 * GitHubへの問い合わせは`GET /api/pull-requests`と同じ取得（installation単位のCI一括取得・ETag）と、
 * 完了があるリポジトリの`deploy.yml`最新実行1件だけ。どちらも読み取りで、並列数と待ち時間に上限を置く。
 */

const EXTERNAL_TIMEOUT_MS = 20_000;
const DEPLOY_FETCH_CONCURRENCY = 4;
const DEPLOY_FETCH_TIMEOUT_MS = 8_000;
/** この時間より古い同期（または同期時刻不明）のリポジトリがあれば`stale`とする */
export const SYNC_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type SummarySourceStatus = {
  generatedAt: string;
  /** 同期済みIssueのうち最も古い同期時刻。1つでも不明ならnull */
  sourceUpdatedAt: string | null;
  stale: boolean;
  staleRepositories: string[];
  unavailable: string[];
  complete: boolean;
};

export type LoadedSummary = {
  summary: DevelopmentSummary;
  source: SummarySourceStatus;
  issues: Issue[];
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

export async function loadDevelopmentSummary(params: {
  userId: string;
  userLogin: string;
  now: Date;
  period: { from: Date; to: Date };
  includePullRequests: boolean;
  includeDeployEvidence: boolean;
}): Promise<LoadedSummary> {
  const { userId, now } = params;
  const unavailable: string[] = [];

  const [repositoryRows, hiddenRows, issues, snoozeRows, queuedRows, dispatch, nextWindowSettings] =
    await Promise.all([
      db.repository.findMany({
        where: { installation: { userInstallations: { some: { userId } } } },
        select: { fullName: true, archived: true, lastSyncedAt: true, installation: { select: { installationId: true } } },
      }),
      db.hiddenRepository.findMany({ where: { userId }, select: { repository: { select: { fullName: true } } } }),
      getIssuesForUser(userId, { bodies: "none" }),
      db.snoozedItem.findMany({
        where: { userId, kind: "ISSUE" },
        include: { repository: { select: { fullName: true } } },
      }),
      db.nightlyRunEntry.findMany({
        where: { status: "QUEUED", kind: "NEXT_WINDOW" },
        orderBy: { createdAt: "asc" },
      }),
      listDispatchState(now, { sweepExpired: false }),
      readNextWindowRunSettings(),
    ]);

  const hidden = new Set(hiddenRows.map((row) => row.repository.fullName));
  const repositories = repositoryRows.map((row) => ({
    fullName: row.fullName,
    archived: row.archived,
    hidden: hidden.has(row.fullName),
  }));
  const visibleRows = repositoryRows.filter((row) => !row.archived && !hidden.has(row.fullName));

  const snoozes: SnoozeEntry[] = snoozeRows.map((row) => ({
    kind: "issue",
    repositoryFullName: row.repository.fullName,
    number: row.number,
    until: row.until?.toISOString() ?? null,
  }));

  const reservations: ReservationRow[] = queuedRows.map((row) => ({
    id: row.id,
    repositoryFullName: row.repositoryFullName,
    issueNumber: row.issueNumber,
    agent: row.agent,
    targetHost: row.targetHost,
    claudeModel: row.claudeModel,
    codexModel: row.codexModel,
    createdAt: row.createdAt,
    reservedResetsAt: row.reservedResetsAt,
  }));

  const snapshot = peekClaudeWindowSnapshot();
  const window = toNextWindowRunWindowView(
    resolveNextWindowRunWindow({
      snapshot,
      now,
      leadMinutes: nextWindowSettings.leadMinutes,
      fiveHourFloorPercent: nextWindowSettings.fiveHourFloorPercent,
      weeklyFloorPercent: nextWindowSettings.weeklyFloorPercent,
    }),
    snapshot,
  );

  // 実行中ジョブの最終heartbeat（ビューに含まれない）。停滞の判定にだけ使う
  const runningJobIds = dispatch.jobs.filter((job) => job.status === "RUNNING").map((job) => job.id);
  const heartbeatRows =
    runningJobIds.length === 0
      ? []
      : await db.dispatchJob.findMany({
          where: { id: { in: runningJobIds } },
          select: { id: true, heartbeatAt: true },
        });
  const jobHeartbeats = Object.fromEntries(
    heartbeatRows.map((row) => [row.id, row.heartbeatAt?.toISOString() ?? null]),
  );

  // PR（読み取りのみ。失敗・時間切れは「不明」として返し0件にしない）
  let pullRequests: PullRequestSummary[] | null = null;
  let failedPullRequestRepositories: string[] = [];
  if (params.includePullRequests) {
    try {
      const list = await withTimeout(
        withGithubApiFeature("pull_request_list", () => fetchPullRequestListForUser(userId, "open")),
        EXTERNAL_TIMEOUT_MS,
      );
      pullRequests = list.pullRequests;
      failedPullRequestRepositories = list.failedRepositories;
    } catch (error) {
      console.error("[aide development-summary] PR一覧を取得できませんでした", error);
      unavailable.push("pullRequests");
    }
  } else {
    unavailable.push("pullRequests");
  }

  // デプロイの証拠: main到達の完了があるリポジトリだけ`deploy.yml`の最新実行を見る
  let deployEvidence: DeployEvidence[] | null = null;
  if (params.includeDeployEvidence) {
    const targets = visibleRows.filter((row) =>
      issues.some(
        (issue) =>
          issue.repositoryFullName === row.fullName &&
          issue.state === "closed" &&
          issue.closedAt !== null &&
          new Date(issue.closedAt).getTime() >= params.period.from.getTime() &&
          new Date(issue.closedAt).getTime() < params.period.to.getTime(),
      ),
    );
    deployEvidence = await mapWithConcurrency(targets, DEPLOY_FETCH_CONCURRENCY, async (row) => {
      const [owner, repo] = row.fullName.split("/");
      try {
        const run = await withTimeout(
          withGithubApiFeature("deploy_status", async () =>
            fetchLatestDeployWorkflowRun(owner, repo, await getInstallationToken(row.installation.installationId)),
          ),
          DEPLOY_FETCH_TIMEOUT_MS,
        );
        return {
          repositoryFullName: row.fullName,
          run: run
            ? { status: run.status, conclusion: run.conclusion, createdAt: run.createdAt, htmlUrl: run.htmlUrl }
            : null,
          error: false,
        } satisfies DeployEvidence;
      } catch {
        return { repositoryFullName: row.fullName, run: null, error: true } satisfies DeployEvidence;
      }
    });
    if (deployEvidence.some((evidence) => evidence.error)) unavailable.push("deployEvidence");
  } else {
    unavailable.push("deployEvidence");
  }

  const closedTimes = issues
    .filter((issue) => issue.closedAt !== null)
    .map((issue) => new Date(issue.closedAt as string).getTime());
  const oldestClosedAtInCache = closedTimes.length > 0 ? new Date(Math.min(...closedTimes)) : null;

  const summary = buildDevelopmentSummary({
    now,
    repositories,
    issues,
    currentUserLogin: params.userLogin,
    snoozes: buildSnoozeMap(snoozes),
    reservations,
    nextWindow: {
      enabled: nextWindowSettings.enabled,
      window: snapshot ? window : null,
      pausedAgents: Object.fromEntries(Object.entries(dispatch.agentPause)),
    },
    jobs: dispatch.jobs,
    jobHeartbeats,
    sessions: dispatch.sessions,
    planRequests: dispatch.planRequests,
    questionRequests: dispatch.questionRequests,
    pullRequests,
    failedPullRequestRepositories,
    deployEvidence,
    period: params.period,
    oldestClosedAtInCache,
  });

  const syncTimes = visibleRows.map((row) => row.lastSyncedAt?.getTime() ?? null);
  const unknownSync = syncTimes.some((time) => time === null);
  const known = syncTimes.filter((time): time is number => time !== null);
  const sourceUpdatedAt = unknownSync || known.length === 0 ? null : new Date(Math.min(...known)).toISOString();
  const staleRepositories = visibleRows
    .filter((row) => row.lastSyncedAt === null || now.getTime() - row.lastSyncedAt.getTime() > SYNC_STALE_AFTER_MS)
    .map((row) => row.fullName)
    .sort((a, b) => a.localeCompare(b));
  if (failedPullRequestRepositories.length > 0 && !unavailable.includes("pullRequests")) {
    unavailable.push("pullRequests:partial");
  }

  return {
    summary,
    issues,
    source: {
      generatedAt: now.toISOString(),
      sourceUpdatedAt,
      stale: staleRepositories.length > 0,
      staleRepositories,
      unavailable,
      complete: unavailable.length === 0 && summary.recentCompletions.historyComplete,
    },
  };
}
