import {
  isWithinClaudeWindowKeepAliveHours,
  resolveClaudeWindowRunningUntil,
} from "@/lib/claude-window-keepalive";
import { readClaudeWindowKeepAliveSettings } from "@/lib/claude-window-keepalive-run";
import type { DispatchJobStatus } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionState } from "@/lib/dispatch/session-state";
import { db } from "@/lib/db";
import {
  classifyNightlyRunOutcome,
  parseNightlyRunOptionLabels,
  selectLatestNightKey,
  type NightlyRunEntryStatus,
  type NightlyRunEntryView,
  type NightlyRunState,
  type ScheduledRunKind,
} from "@/lib/nightly-run";
import { nightlyRunIssueKey } from "@/lib/nightly-run-db";
import {
  resolveNextWindowRunWindow,
  toNextWindowRunWindowView,
  type NextWindowRunSettings,
} from "@/lib/next-window-run";
import {
  peekClaudeWindowSnapshot,
  readClaudeWindowSnapshot,
  readNextWindowRunSettings,
} from "@/lib/next-window-run-db";

/**
 * 「予約実行」画面に出す状態を組み立てる（#2995）。
 *
 * 材料は**DBにあるものだけ**（同期済みのIssue・ジョブ・セッション）。GitHubへは問い合わせない。
 * 結果の分類（`classifyNightlyRunOutcome`）は純関数に閉じ、ここは引いて渡すだけ。
 *
 * 結果は「直近の枠」の1回ぶんだけ出す。前の枠のぶんは表に残っているが画面には出さない
 * （並べると今の予定と混ざる。古い行は`claim/route.ts`の巡回が30日で消す）。
 */

type EntryRow = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  targetHost: string;
  agent: string;
  claudeModel: string | null;
  codexModel?: string | null;
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
    codexModel: row.codexModel ?? null,
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

/**
 * 枠を取りに行ってよいか。取得は最小の推論リクエスト1本で、送信そのものが5時間枠を
 * 開始してしまうため、**次枠実行がONで、かつ予定が1件以上あるときだけ**呼ぶ（#2995・#3005）。
 * 起動判定を持つ`next-window-run-launch.ts`の`launchNextWindowRunEntries`（`!settings.enabled`→
 * return、`entries.length===0`→returnの2段の早期returnで同じANDを表す）と意図を揃えている。
 */
export function shouldReadNextWindowSnapshot(
  settings: Pick<NextWindowRunSettings, "enabled">,
  queuedCount: number,
): boolean {
  return settings.enabled && queuedCount > 0;
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
  const nextWindowSettings = await readNextWindowRunSettings();

  const queuedRows = await db.nightlyRunEntry.findMany({
    where: { status: "QUEUED", kind: "NEXT_WINDOW" },
    orderBy: { createdAt: "asc" },
  });
  const processedRows = await db.nightlyRunEntry.findMany({
    where: {
      status: { in: ["LAUNCHED", "SKIPPED"] },
      kind: "NEXT_WINDOW",
      nightKey: { not: null },
    },
    orderBy: { resolvedAt: "asc" },
  });

  const nextWindow = splitByKind([...queuedRows, ...processedRows], "NEXT_WINDOW");
  const results = nextWindow.results;

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

  // 5時間枠を開けておく（#3032）がONで時間帯の中なら、**取得せずに**最後に見た枠でメーターを出す。
  // `useNightlyRun`はシェルで常に取り直しているので、ここで取得すると画面を開いているだけで
  // 5分おきに探りが送られてしまう（枠が動いている間は送らない、という設計が崩れる）
  const keepAliveSettings = await readClaudeWindowKeepAliveSettings();
  const keepAliveWithinHours = isWithinClaudeWindowKeepAliveHours(keepAliveSettings, now);
  const shouldFetchWindow = shouldReadNextWindowSnapshot(
    nextWindowSettings,
    nextWindow.queued.length,
  );
  const shouldReadWindow =
    shouldFetchWindow || (keepAliveSettings.enabled && keepAliveWithinHours);
  const snapshot = shouldFetchWindow
    ? await readClaudeWindowSnapshot()
    : shouldReadWindow
      ? peekClaudeWindowSnapshot()
      : null;
  const claudeWindow = shouldReadWindow
    ? toNextWindowRunWindowView(
        resolveNextWindowRunWindow({
          snapshot,
          now,
          leadMinutes: nextWindowSettings.leadMinutes,
          fiveHourFloorPercent: nextWindowSettings.fiveHourFloorPercent,
          weeklyFloorPercent: nextWindowSettings.weeklyFloorPercent,
        }),
        snapshot,
      )
    : null;

  return {
    nextWindow: {
      settings: nextWindowSettings,
      window: claudeWindow,
      queued: nextWindow.queued.map(view),
      results: nextWindow.latestKey
        ? { runKey: nextWindow.latestKey, entries: nextWindow.results.map(view) }
        : null,
    },
    keepAlive: {
      settings: {
        enabled: keepAliveSettings.enabled,
        startHour: keepAliveSettings.startHour,
        endHour: keepAliveSettings.endHour,
      },
      withinHours: keepAliveWithinHours,
      probedAt: keepAliveSettings.probedAt?.toISOString() ?? null,
      runningUntil:
        resolveClaudeWindowRunningUntil(snapshot?.resetsAt ?? null, now)?.toISOString() ?? null,
    },
  };
}
