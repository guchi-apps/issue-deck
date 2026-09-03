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
} from "@/lib/nightly-run";
import { nightlyRunIssueKey, readNightlyRunSettings } from "@/lib/nightly-run-db";

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

export async function listNightlyRunState(now: Date = new Date()): Promise<NightlyRunState> {
  const settings = await readNightlyRunSettings();
  const window = resolveNightlyRunWindow(now, settings.startHour);

  const queued = await db.nightlyRunEntry.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
  });
  const processed = await db.nightlyRunEntry.findMany({
    where: { status: { in: ["LAUNCHED", "SKIPPED"] }, nightKey: { not: null } },
    orderBy: { resolvedAt: "asc" },
  });
  const latestNightKey = selectLatestNightKey(processed);
  const results = latestNightKey
    ? processed.filter((row) => row.nightKey === latestNightKey)
    : [];

  const rows = [...queued, ...results];
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

  return {
    settings,
    window: toNightlyRunWindowView(window),
    queued: queued.map(view),
    results: latestNightKey ? { nightKey: latestNightKey, entries: results.map(view) } : null,
  };
}
