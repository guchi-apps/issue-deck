import type { DispatchJobStatus } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionState } from "@/lib/dispatch/session-state";
import { db } from "@/lib/db";
import {
  classifyNightlyRunOutcome,
  parseNightlyRunOptionLabels,
  resolveNightlyRunWindow,
  selectLatestNightKey,
  toNightlyRunWindowView,
  type NightlyRunEntryStatus,
  type NightlyRunEntryView,
  type NightlyRunState,
  type ScheduledRunKind,
} from "@/lib/nightly-run";
import { nightlyRunIssueKey, readNightlyRunSettings } from "@/lib/nightly-run-db";
import {
  resolveNextWindowRunWindow,
  toNextWindowRunWindowView,
} from "@/lib/next-window-run";
import {
  readClaudeWindowSnapshot,
  readNextWindowRunSettings,
} from "@/lib/next-window-run-db";

/**
 * 「夜間実行」画面に出す状態を組み立てる（#2772）。
 *
 * 材料は**DBにあるものだけ**（同期済みのIssue・ジョブ・セッション）。GitHubへは問い合わせない。
 * 結果の分類（`classifyNightlyRunOutcome`）は純関数に閉じ、ここは引いて渡すだけ。
 *
 * 結果は「直近の夜」の1回ぶんだけ出す。前の夜のぶんは表に残っているが画面には出さない
 * （並べると今夜の予定と混ざる。古い行は起動処理が30日で消す）。
 */

type EntryRow = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  targetHost: string;
  agent: string;
  claudeModel: string | null;
  optionLabels: unknown;
  kind: ScheduledRunKind;
  status: NightlyRunEntryStatus;
  nightKey: string | null;
  skipReason: string | null;
  dispatchJobId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

type IssueRow = {
  githubIssueId: bigint;
  title: string;
  state: "OPEN" | "CLOSED";
  projectStatus: string | null;
  labels: { name: string }[];
};

async function selectIssues(rows: readonly EntryRow[]): Promise<Map<string, IssueRow>> {
  const map = new Map<string, IssueRow>();
  if (rows.length === 0) return map;
  const issues = await db.issue.findMany({
    where: {
      OR: rows.map((row) => ({
        number: row.issueNumber,
        repository: { fullName: row.repositoryFullName },
      })),
    },
    select: {
      number: true,
      githubIssueId: true,
      title: true,
      state: true,
      projectStatus: true,
      labels: { select: { name: true } },
      repository: { select: { fullName: true } },
    },
  });
  for (const issue of issues) {
    map.set(nightlyRunIssueKey(issue.repository.fullName, issue.number), issue);
  }
  return map;
}

async function selectJobs(rows: readonly EntryRow[]): Promise<Map<string, DispatchJobStatus>> {
  const ids = rows.map((row) => row.dispatchJobId).filter((id): id is string => id !== null);
  const map = new Map<string, DispatchJobStatus>();
  if (ids.length === 0) return map;
  const jobs = await db.dispatchJob.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  for (const job of jobs) map.set(job.id, job.status);
  return map;
}

/**
 * Issueごとに1件のセッションを選ぶ。生きているものを優先し、無ければ最新
 * （`issue-execution-target.ts`の`newestSessionForIssue`と同じ向き）。
 */
async function selectSessions(rows: readonly EntryRow[]): Promise<Map<string, DispatchSessionState>> {
  const map = new Map<string, DispatchSessionState>();
  if (rows.length === 0) return map;
  const sessions = await db.dispatchSession.findMany({
    where: {
      OR: rows.map((row) => ({
        repositoryFullName: row.repositoryFullName,
        issueNumber: row.issueNumber,
      })),
    },
    select: { repositoryFullName: true, issueNumber: true, state: true, lastReportedAt: true },
    orderBy: { lastReportedAt: "desc" },
  });
  for (const session of sessions) {
    const key = nightlyRunIssueKey(session.repositoryFullName, session.issueNumber);
    const current = map.get(key);
    if (current === "ALIVE") continue;
    if (current === undefined || session.state === "ALIVE") map.set(key, session.state);
  }
  return map;
}

function toView(
  row: EntryRow,
  issue: IssueRow | undefined,
  jobStatus: DispatchJobStatus | undefined,
  sessionState: DispatchSessionState | undefined,
): NightlyRunEntryView {
  return {
    id: row.id,
    repositoryFullName: row.repositoryFullName,
    issueNumber: row.issueNumber,
    issueId: issue ? String(issue.githubIssueId) : null,
    issueTitle: issue?.title ?? null,
    targetHost: row.targetHost,
    agent: row.agent,
    claudeModel: row.claudeModel,
    optionLabels: parseNightlyRunOptionLabels(row.optionLabels),
    kind: row.kind,
    status: row.status,
    nightKey: row.nightKey,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    outcome:
      row.status === "QUEUED"
        ? null
        : classifyNightlyRunOutcome({
            entry: { status: row.status, skipReason: row.skipReason },
            issue: issue
              ? { state: issue.state, projectStatus: issue.projectStatus, labels: issue.labels }
              : null,
            job: jobStatus ? { status: jobStatus } : null,
            session: sessionState ? { state: sessionState } : null,
          }),
  };
}

/** 種類ごとに「予定」と「直近1回の結果」に切り分ける */
function splitByKind(rows: readonly EntryRow[], kind: ScheduledRunKind) {
  const ofKind = rows.filter((row) => row.kind === kind);
  const queued = ofKind.filter((row) => row.status === "QUEUED");
  const processed = ofKind.filter((row) => row.status !== "QUEUED");
  const latestKey = selectLatestNightKey(processed);
  const results = latestKey ? processed.filter((row) => row.nightKey === latestKey) : [];
  return { queued, latestKey, results };
}

export async function listNightlyRunState(now: Date = new Date()): Promise<NightlyRunState> {
  const settings = await readNightlyRunSettings();
  const window = resolveNightlyRunWindow(now, settings.startHour);
  const nextWindowSettings = await readNextWindowRunSettings();

  const queuedRows = await db.nightlyRunEntry.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
  });
  const processedRows = await db.nightlyRunEntry.findMany({
    where: { status: { in: ["LAUNCHED", "SKIPPED"] }, nightKey: { not: null } },
    orderBy: { resolvedAt: "asc" },
  });

  const nightly = splitByKind([...queuedRows, ...processedRows], "NIGHTLY");
  const nextWindow = splitByKind([...queuedRows, ...processedRows], "NEXT_WINDOW");
  const results = [...nightly.results, ...nextWindow.results];

  const rows = [...queuedRows, ...results];
  const [issues, jobs, sessions] = await Promise.all([
    selectIssues(rows),
    selectJobs(results),
    selectSessions(results),
  ]);

  const view = (row: EntryRow) => {
    const key = nightlyRunIssueKey(row.repositoryFullName, row.issueNumber);
    return toView(
      row,
      issues.get(key),
      row.dispatchJobId ? jobs.get(row.dispatchJobId) : undefined,
      sessions.get(key),
    );
  };

  // **枠を取りに行くのは、次枠実行がONか予定があるときだけ**（#2995）。取得は最小の推論
  // リクエスト1本で、送信そのものが5時間枠を開始してしまう（`next-window-run-db.ts`）
  const shouldReadWindow = nextWindowSettings.enabled || nextWindow.queued.length > 0;
  const snapshot = shouldReadWindow ? await readClaudeWindowSnapshot() : null;
  const claudeWindow = shouldReadWindow
    ? toNextWindowRunWindowView(
        resolveNextWindowRunWindow({
          snapshot,
          now,
          leadMinutes: nextWindowSettings.leadMinutes,
        }),
        snapshot,
      )
    : null;

  return {
    settings,
    window: toNightlyRunWindowView(window),
    queued: nightly.queued.map(view),
    results: nightly.latestKey
      ? { nightKey: nightly.latestKey, entries: nightly.results.map(view) }
      : null,
    nextWindow: {
      settings: nextWindowSettings,
      window: claudeWindow,
      queued: nextWindow.queued.map(view),
      results: nextWindow.latestKey
        ? { runKey: nextWindow.latestKey, entries: nextWindow.results.map(view) }
        : null,
    },
  };
}
