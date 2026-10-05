import { checkUserReason, CHECK_USER_REASON_TEXT, type CheckUserReason } from "@/lib/github/approval-labels";
import { selectCheckUserRunningIssueIds } from "@/lib/check-user-attention";
import {
  DISPATCH_CLAIM_TIMEOUT_MS,
  DISPATCH_HEARTBEAT_TIMEOUT_MS,
  SESSION_LAUNCH_JOB_KINDS,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import type { SessionQuestionRequestView } from "@/lib/dispatch/session-question-request";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { resolveProgressStatus, type ProgressStatusKey } from "@/lib/issue-progress";
import {
  computeNavCountsForFilters,
  selectNavViewIssues,
  type IssueFilterInput,
} from "@/lib/issue-stats";
import { computeManualStepReadiness } from "@/lib/manual-step-attention";
import { describeNextWindowRunQuotaBlock, type NextWindowRunWindowView } from "@/lib/next-window-run";
import { filterPullRequestsByView, pullRequestsAwaitingUserMerge } from "@/lib/pull-request-list";
import { selectSnoozedIssueIds, type SnoozeMap } from "@/lib/snooze";
import type { Issue, NavViewId } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * AIDE向け開発状況サマリ（#3999）の集計。
 *
 * **ここは純関数で、DB・GitHubへは触れない。** 材料は呼び出し側（`aide-development-summary-load.ts`）が
 * 読み取り専用で集めて渡す。Issueの件数は画面の左メニューと同じ`selectNavViewIssues`・
 * `computeNavCountsForFilters`を通すので、同じ母集団・時点なら画面の数字と一致する（AIDE側に
 * 独自の進捗判定を持たせない）。
 *
 * **件数は必ず「全件の配列の長さ」から出す。** 要対応の上位N件や先頭ページの件数を総件数にしない。
 */

export const AIDE_SUMMARY_SCHEMA_VERSION = 1;

/** 集計の区分。1つの項目（Issue・PR・ジョブ・予約）が複数の区分へ載ることがある */
export const SUMMARY_CATEGORIES = [
  "notStarted",
  "inProgress",
  "reserved",
  "checkUser",
  "manualStep",
  "problems",
  "pullRequests",
  "deployment",
  "recentCompletions",
] as const;
export type SummaryCategory = (typeof SUMMARY_CATEGORIES)[number];

export type SummaryItemKind = "issue" | "pr" | "job" | "reservation" | "deployment";

export type SummaryItem = {
  kind: SummaryItemKind;
  /** カテゴリをまたいで安定な識別子（`issue:<owner/repo>#<番号>`など） */
  id: string;
  category: SummaryCategory;
  repositoryFullName: string;
  owner: string;
  repo: string;
  /** Issue・PRの番号。ジョブ・予約・デプロイでは対象Issueの番号（無ければnull） */
  number: number | null;
  title: string | null;
  url: string | null;
  /** 機械可読な理由コード */
  reasonCode: string;
  /** 人が読む理由 */
  reason: string;
  /** 状態が最後に変わった時刻（ISO8601）。不明ならnull */
  updatedAt: string | null;
};

export type ReservationRow = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  agent: string;
  targetHost: string;
  claudeModel: string | null;
  codexModel: string | null;
  createdAt: Date;
  reservedResetsAt: Date | null;
};

export type SummaryRepository = { fullName: string; archived: boolean; hidden: boolean };

export type DeployEvidence = {
  repositoryFullName: string;
  /** `deploy.yml`の最新実行。取得できなければnull（＝unknown） */
  run: { status: string; conclusion: string | null; createdAt: string; htmlUrl: string } | null;
  error: boolean;
};

export type SummaryInput = {
  now: Date;
  /** 認可された全リポジトリ（アーカイブ・非表示を含む）。母集団の除外理由の説明に使う */
  repositories: SummaryRepository[];
  /** 認可された全Issue（アーカイブ・非表示を含む。本文は不要） */
  issues: Issue[];
  currentUserLogin: string | null;
  snoozes: SnoozeMap;
  reservations: ReservationRow[];
  nextWindow: {
    enabled: boolean;
    window: NextWindowRunWindowView | null;
    pausedAgents: Record<string, string | null>;
  };
  jobs: DispatchJobView[];
  /** 実行中ジョブの最終heartbeat（ISO8601）。ビューには含まれないため別に渡す */
  jobHeartbeats: Record<string, string | null>;
  sessions: DispatchSessionView[];
  planRequests: SessionPlanRequestView[];
  questionRequests: SessionQuestionRequestView[];
  /** PR一覧。取得していない・取れなかったときはnull（0件で代用しない） */
  pullRequests: PullRequestSummary[] | null;
  failedPullRequestRepositories: string[];
  deployEvidence: DeployEvidence[] | null;
  /** 完了集計の半開区間 [from, to) */
  period: { from: Date; to: Date };
  /** 同期済みIssueキャッシュのうち最も古いclosedAt。履歴が足りているかの判定に使う */
  oldestClosedAtInCache: Date | null;
};

const DEFAULT_FILTERS: IssueFilterInput = {
  q: "",
  repos: [],
  state: "open",
  labels: [],
  assignee: null,
};

function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
}

export function issueItemId(repositoryFullName: string, number: number): string {
  return `issue:${repositoryFullName}#${number}`;
}

function issueItem(
  issue: Issue,
  category: SummaryCategory,
  reasonCode: string,
  reason: string,
  updatedAt: string | null = issue.updatedAt,
): SummaryItem {
  return {
    kind: "issue",
    id: issueItemId(issue.repositoryFullName, issue.number),
    category,
    repositoryFullName: issue.repositoryFullName,
    ...splitRepo(issue.repositoryFullName),
    number: issue.number,
    title: issue.title,
    url: issue.htmlUrl,
    reasonCode,
    reason,
    updatedAt,
  };
}

function prItem(pr: PullRequestSummary, reasonCode: string, reason: string): SummaryItem {
  return {
    kind: "pr",
    id: `pr:${pr.repositoryFullName}#${pr.number}`,
    category: "pullRequests",
    repositoryFullName: pr.repositoryFullName,
    ...splitRepo(pr.repositoryFullName),
    number: pr.number,
    title: pr.title,
    url: pr.htmlUrl,
    reasonCode,
    reason,
    updatedAt: pr.mergedAt,
  };
}

const PROGRESS_LABEL: Record<ProgressStatusKey, string> = {
  ready: "未着手",
  planning: "計画中",
  implementation: "実装中",
  "develop-pr": "developへPR対応中",
  develop: "develop反映済み（main未反映）",
  release: "mainへリリース中",
  done: "main反映済み",
  closed: "対応終了",
};

export type CountBlock = { issues: number };

export type RepositorySummaryCounts = {
  notStarted: { issues: number };
  inProgress: { issues: number; byProgress: Record<string, number> };
  reserved: { reservations: number; issues: number };
  checkUser: {
    issues: number;
    pullRequests: number | null;
    byReason: Record<string, number>;
    excludedRunning: number;
  };
  manualStep: { actionableIssues: number; waitingForPrerequisitesIssues: number };
  problems: { total: number; byKind: Record<string, number> };
  pullRequests: PullRequestCounts | null;
  deployment: {
    awaitingMainIssues: number;
    mainMergeInProgressIssues: number;
  };
  recentCompletions: { completedIssues: number; reachedMainIssues: number; deploySucceededIssues: number | null; closedWithoutMainIssues: number };
};

export type PullRequestCounts = {
  open: number;
  draft: number;
  /** CI・自動マージ判定の完了待ち（draftを除く） */
  reviewWaiting: number;
  /** 人のマージ待ち（画面の確認待ちに出るもの） */
  mergeWaiting: number;
  /** 自動レビューが「要修正」と判定している */
  fixWaiting: number;
  ciFailed: number;
  conflict: number;
  /** CI状態・コンフリクト有無が未取得（unknown / null）のdraft以外 */
  unknown: number;
};

function emptyCounts(): RepositorySummaryCounts {
  return {
    notStarted: { issues: 0 },
    inProgress: { issues: 0, byProgress: {} },
    reserved: { reservations: 0, issues: 0 },
    checkUser: { issues: 0, pullRequests: null, byReason: {}, excludedRunning: 0 },
    manualStep: { actionableIssues: 0, waitingForPrerequisitesIssues: 0 },
    problems: { total: 0, byKind: {} },
    pullRequests: null,
    deployment: { awaitingMainIssues: 0, mainMergeInProgressIssues: 0 },
    recentCompletions: { completedIssues: 0, reachedMainIssues: 0, deploySucceededIssues: null, closedWithoutMainIssues: 0 },
  };
}

export type DevelopmentSummary = {
  population: {
    repositories: number;
    excludedArchived: string[];
    excludedHidden: string[];
    issues: number;
    snoozedIssues: number;
  };
  totals: RepositorySummaryCounts;
  byRepository: Record<string, RepositorySummaryCounts>;
  /** 区分ごとの全件。件数はここの長さから出している */
  items: Record<SummaryCategory, SummaryItem[]>;
  reservation: {
    queuedReservations: number;
    uniqueIssues: number;
    byAgent: Record<string, number>;
    enabled: boolean;
    windowPhase: string | null;
    windowOpensAt: string | null;
    blockers: string[];
  };
  problems: { currentTotal: number };
  pullRequestsAvailable: boolean;
  recentCompletions: {
    from: string;
    to: string;
    historyComplete: boolean;
    historyNote: string | null;
  };
  /** 区分間の重複の説明（応答にそのまま載せる） */
  overlapNotes: string[];
  warnings: string[];
};

/** ジョブの現在の停止・失敗を判定する（最新のジョブ1件だけが現在の状態） */
function problemKindOf(job: DispatchJobView, heartbeatAt: string | null, nowMs: number): "failed" | "timeout" | "stalled" | null {
  if (job.status === "FAILED") return "failed";
  if (job.status === "TIMEOUT") return "timeout";
  if (job.status === "CLAIMED" && job.claimedAt) {
    return nowMs - new Date(job.claimedAt).getTime() > DISPATCH_CLAIM_TIMEOUT_MS ? "stalled" : null;
  }
  if (job.status === "RUNNING") {
    const basis = heartbeatAt ?? job.startedAt;
    return basis && nowMs - new Date(basis).getTime() > DISPATCH_HEARTBEAT_TIMEOUT_MS ? "stalled" : null;
  }
  return null;
}

const PROBLEM_REASON: Record<string, string> = {
  failed: "最新の実行ジョブが失敗しています",
  timeout: "最新の実行ジョブが時間切れで終了しています",
  stalled: "実行ジョブの報告が止まっています（停滞）",
};

function bump(record: Record<string, number>, key: string, by = 1) {
  record[key] = (record[key] ?? 0) + by;
}

export function buildDevelopmentSummary(input: SummaryInput): DevelopmentSummary {
  const nowMs = input.now.getTime();
  const warnings: string[] = [];

  const archived = new Set(input.repositories.filter((r) => r.archived).map((r) => r.fullName));
  const hidden = new Set(
    input.repositories.filter((r) => r.hidden && !r.archived).map((r) => r.fullName),
  );
  const visibleRepoNames = input.repositories
    .filter((r) => !r.archived && !r.hidden)
    .map((r) => r.fullName)
    .sort((a, b) => a.localeCompare(b));
  const visibleSet = new Set(visibleRepoNames);

  // 画面の母集団と同じく、アーカイブ・非表示を除いた集合を全ビューの母集団（前提判定の参照集合を
  // 含む）にする。**リポジトリ別の内訳は、この1つの集合から切り出す**（他リポジトリの前提を失わない）
  const issues = input.issues.filter((issue) => visibleSet.has(issue.repositoryFullName));
  const issueById = new Map(issues.map((issue) => [issue.id, issue] as const));
  const issueByKey = new Map(issues.map((issue) => [issueItemId(issue.repositoryFullName, issue.number), issue] as const));

  const snoozedIds = selectSnoozedIssueIds(issues, input.snoozes, nowMs);

  // 予約: 積まれているIssueは未着手から外す（#3822）
  const reservedIssueIds = new Set<string>();
  const reservationItems: SummaryItem[] = [];
  const byAgent: Record<string, number> = {};
  const windowPhase = input.nextWindow.window?.phase ?? null;
  const blockers: string[] = [];
  if (!input.nextWindow.enabled) blockers.push("次枠実行がOFFのため、予約は起動されません");
  if (input.nextWindow.enabled && (windowPhase === null || windowPhase === "unknown")) {
    blockers.push("Claudeの5時間枠の状況が未取得のため、起動可否を判定できません");
  }
  if (input.nextWindow.window?.quotaBlock) {
    blockers.push(describeNextWindowRunQuotaBlock(input.nextWindow.window.quotaBlock));
  }
  for (const [agent, reason] of Object.entries(input.nextWindow.pausedAgents)) {
    if (reason) blockers.push(`${agent}の新規実行が一時停止されています（${reason}）`);
  }
  for (const entry of input.reservations) {
    if (!visibleSet.has(entry.repositoryFullName)) continue;
    const issue = issueByKey.get(issueItemId(entry.repositoryFullName, entry.issueNumber));
    if (issue) reservedIssueIds.add(issue.id);
    bump(byAgent, entry.agent);
    const waitReason =
      blockers.length > 0
        ? blockers.join(" / ")
        : windowPhase === "waiting"
          ? `枠の残りが開始の目安（${input.nextWindow.window?.opensAt ?? "不明"}）になるまで待っています`
          : entry.reservedResetsAt && entry.reservedResetsAt.getTime() > nowMs
            ? `積んだときの枠がまだ続いています（${entry.reservedResetsAt.toISOString()}にリセット）`
            : "起動の順番待ちです";
    reservationItems.push({
      kind: "reservation",
      id: `reservation:${entry.id}`,
      category: "reserved",
      repositoryFullName: entry.repositoryFullName,
      ...splitRepo(entry.repositoryFullName),
      number: entry.issueNumber,
      title: issue?.title ?? null,
      url: issue?.htmlUrl ?? null,
      reasonCode: blockers.length > 0 ? "blocked" : "queued",
      reason: `${entry.agent}（${entry.targetHost}）で次の枠に起動予定。${waitReason}`,
      updatedAt: entry.createdAt.toISOString(),
    });
  }

  // 画面と同じ数え方でIssueのビューごとの集合を求める
  const selectView = (view: NavViewId) =>
    selectNavViewIssues(view, issues, DEFAULT_FILTERS, input.currentUserLogin, issues, snoozedIds, reservedIssueIds);

  const pullRequests = input.pullRequests?.filter((pr) => visibleSet.has(pr.repositoryFullName)) ?? null;
  const checkUserMatched = selectView("check-user");
  const runningIds = selectCheckUserRunningIssueIds(checkUserMatched, {
    pullRequests: pullRequests ?? [],
    sessions: input.sessions,
    planRequests: input.planRequests,
    questionRequests: input.questionRequests,
    jobs: input.jobs,
    now: nowMs,
  });
  if (pullRequests === null) {
    warnings.push("PR一覧を取得できなかったため、確認待ちの実行中判定とPR集計は下限・不明として扱います");
  }

  const items = Object.fromEntries(SUMMARY_CATEGORIES.map((c) => [c, [] as SummaryItem[]])) as Record<SummaryCategory, SummaryItem[]>;

  for (const issue of selectView("not-started")) {
    items.notStarted.push(issueItem(issue, "notStarted", "ready", "未着手（予約済み・保留中は除外）"));
  }
  for (const issue of selectView("in-progress")) {
    const progress = resolveProgressStatus(issue);
    items.inProgress.push(
      issueItem(issue, "inProgress", progress, issue.dispatchPendingAt && progress === "ready" ? "実行ジョブの起動待ち" : PROGRESS_LABEL[progress]),
    );
  }
  items.reserved.push(...reservationItems);
  const checkUserItemById = new Map<string, SummaryItem>();
  for (const issue of checkUserMatched) {
    const reason: CheckUserReason | null = checkUserReason(issue.labels);
    const running = runningIds.has(issue.id);
    const item = issueItem(
      issue,
      "checkUser",
      running ? "agent-running" : (reason ?? "unspecified"),
      running ? "エージェント稼働中のため今は対応できません" : reason ? CHECK_USER_REASON_TEXT[reason] : "確認待ち（理由ラベルなし）",
      issue.checkUserLabeledAt ?? issue.updatedAt,
    );
    checkUserItemById.set(issue.id, item);
    items.checkUser.push(item);
  }
  const manualMatched = selectView("manual-step");
  const readiness = computeManualStepReadiness(manualMatched, issues);
  for (const issue of manualMatched) {
    const ready = readiness.get(issue.id)?.ready ?? true;
    items.manualStep.push(
      issueItem(issue, "manualStep", ready ? "actionable" : "waiting-prerequisites", ready ? "今実行できる手作業" : "前提のIssue・PRの完了待ち"),
    );
  }

  // 問題・停止: 最新のジョブ1件だけを現在の状態とする。閉じたIssue・新しいジョブが続いたIssueは数えない
  const latestJobByIssue = new Map<string, DispatchJobView>();
  for (const job of input.jobs) {
    if (!(SESSION_LAUNCH_JOB_KINDS as readonly string[]).includes(job.kind)) continue;
    const key = issueItemId(job.repositoryFullName, job.issueNumber);
    const current = latestJobByIssue.get(key);
    if (!current || new Date(job.createdAt).getTime() > new Date(current.createdAt).getTime()) {
      latestJobByIssue.set(key, job);
    }
  }
  for (const [key, job] of latestJobByIssue) {
    const issue = issueByKey.get(key);
    if (!issue || issue.state !== "open") continue;
    const kind = problemKindOf(job, input.jobHeartbeats[job.id] ?? null, nowMs);
    if (!kind) continue;
    items.problems.push({
      kind: "job",
      id: `job:${job.id}`,
      category: "problems",
      repositoryFullName: job.repositoryFullName,
      ...splitRepo(job.repositoryFullName),
      number: job.issueNumber,
      title: issue.title,
      url: issue.htmlUrl,
      reasonCode: kind,
      reason: job.message ? `${PROBLEM_REASON[kind]}: ${job.message}` : PROBLEM_REASON[kind],
      updatedAt: job.finishedAt ?? job.claimedAt ?? job.createdAt,
    });
  }
  // 予約の起動を妨げる条件は、予約を持つリポジトリ分の項目として別に出す
  for (const item of reservationItems.filter((r) => r.reasonCode === "blocked")) {
    items.problems.push({ ...item, category: "problems", id: `reservation-blocked:${item.id}`, reasonCode: "reservation-blocked" });
  }

  // PR
  let prCounts: PullRequestCounts | null = null;
  const prFailedRepos = new Set(input.failedPullRequestRepositories);
  if (pullRequests !== null) {
    const open = pullRequests.filter((pr) => pr.state === "open");
    const reviewWaiting = filterPullRequestsByView(open, "in-progress").filter((pr) => !pr.draft);
    const mergeWaiting = pullRequestsAwaitingUserMerge(open);
    const awaitingSet = new Set(mergeWaiting.map((pr) => pr.id));
    for (const pr of open) {
      if (pr.draft) continue;
      if (reviewWaiting.includes(pr)) items.pullRequests.push(prItem(pr, "review-waiting", "CI・自動マージ判定の完了待ち"));
      if (awaitingSet.has(pr.id)) items.pullRequests.push(prItem(pr, "merge-waiting", "人のマージ待ち"));
      if (pr.reviewVerdict?.reviewKind === "changes-requested") items.pullRequests.push(prItem(pr, "fix-waiting", "自動レビューが要修正と判定"));
      if (pr.ciState === "failure") items.pullRequests.push(prItem(pr, "ci-failed", "CIが失敗しています"));
      if (pr.mergeable === false) items.pullRequests.push(prItem(pr, "conflict", "baseブランチとコンフリクトしています"));
      if (pr.ciState === "unknown" || pr.mergeable === null) items.pullRequests.push(prItem(pr, "unknown", "CI状態またはコンフリクト有無が未取得です"));
    }
    for (const pr of open.filter((p) => p.draft)) items.pullRequests.push(prItem(pr, "draft", "draftのPR"));
    const count = (code: string) => items.pullRequests.filter((i) => i.reasonCode === code).length;
    prCounts = {
      open: open.length,
      draft: count("draft"),
      reviewWaiting: count("review-waiting"),
      mergeWaiting: count("merge-waiting"),
      fixWaiting: count("fix-waiting"),
      ciFailed: count("ci-failed"),
      conflict: count("conflict"),
      unknown: count("unknown"),
    };
  }

  // 本番反映: develop反映後main未反映（Develop）とmainへのリリース中（Release）
  for (const issue of selectView("release-pending")) {
    const progress = resolveProgressStatus(issue);
    items.deployment.push({
      ...issueItem(
        issue,
        "deployment",
        progress === "develop" ? "awaiting-main" : "main-merge-in-progress",
        progress === "develop" ? "developに反映済みで、mainへ未反映" : "mainへのリリースPR対応中",
      ),
    });
  }

  // 最近の完了。期間は半開区間 [from, to)
  const evidenceByRepo = new Map((input.deployEvidence ?? []).map((e) => [e.repositoryFullName, e] as const));
  const completed = issues.filter((issue) => {
    if (issue.state !== "closed" || !issue.closedAt) return false;
    const closedAt = new Date(issue.closedAt).getTime();
    return closedAt >= input.period.from.getTime() && closedAt < input.period.to.getTime();
  });
  const deployStateOf = (issue: Issue): { code: string; text: string } => {
    const evidence = evidenceByRepo.get(issue.repositoryFullName);
    if (!input.deployEvidence || !evidence || evidence.error || !evidence.run) {
      return { code: "deploy-unknown", text: "デプロイの証拠を取得できていません" };
    }
    const closedAt = issue.closedAt ? new Date(issue.closedAt).getTime() : 0;
    if (new Date(evidence.run.createdAt).getTime() < closedAt) {
      return { code: "deploy-waiting", text: "main反映後のデプロイ実行がまだ現れていません" };
    }
    if (evidence.run.status !== "completed") return { code: "deploy-running", text: "デプロイ実行中" };
    return evidence.run.conclusion === "success"
      ? { code: "deploy-succeeded", text: "main反映後のデプロイが成功しています（最新の実行から推定）" }
      : { code: "deploy-failed", text: "main反映後のデプロイが失敗しています" };
  };
  for (const issue of completed) {
    const reachedMain = resolveProgressStatus(issue) === "done";
    if (!reachedMain) {
      const dismissed = issue.stateReason === "not_planned";
      items.recentCompletions.push(
        issueItem(
          issue,
          "recentCompletions",
          dismissed ? "closed-not-planned" : "closed-without-main",
          dismissed ? "対応しない判断でclose（実装完了ではない）" : "mainへ到達せずclose（実装完了とは断定できない）",
          issue.closedAt,
        ),
      );
      continue;
    }
    const deploy = deployStateOf(issue);
    items.recentCompletions.push(issueItem(issue, "recentCompletions", deploy.code, `main到達。${deploy.text}`, issue.closedAt));
  }

  // 件数。全て「区分ごとの全件」から数える
  const totals = emptyCounts();
  const byRepository: Record<string, RepositorySummaryCounts> = Object.fromEntries(
    visibleRepoNames.map((name) => [name, emptyCounts()]),
  );
  const targets = (repo: string) => [totals, byRepository[repo]].filter((x): x is RepositorySummaryCounts => Boolean(x));

  for (const item of items.notStarted) for (const c of targets(item.repositoryFullName)) c.notStarted.issues += 1;
  for (const item of items.inProgress) for (const c of targets(item.repositoryFullName)) { c.inProgress.issues += 1; bump(c.inProgress.byProgress, item.reasonCode); }
  for (const item of items.reserved) for (const c of targets(item.repositoryFullName)) c.reserved.reservations += 1;
  const reservedIssueKeys = new Set<string>();
  for (const item of items.reserved) {
    const key = issueItemId(item.repositoryFullName, item.number ?? 0);
    if (reservedIssueKeys.has(key)) continue;
    reservedIssueKeys.add(key);
    for (const c of targets(item.repositoryFullName)) c.reserved.issues += 1;
  }
  for (const item of items.checkUser) {
    for (const c of targets(item.repositoryFullName)) {
      if (item.reasonCode === "agent-running") c.checkUser.excludedRunning += 1;
      else {
        c.checkUser.issues += 1;
        bump(c.checkUser.byReason, item.reasonCode);
      }
    }
  }
  for (const item of items.manualStep) {
    for (const c of targets(item.repositoryFullName)) {
      if (item.reasonCode === "actionable") c.manualStep.actionableIssues += 1;
      else c.manualStep.waitingForPrerequisitesIssues += 1;
    }
  }
  for (const item of items.problems) for (const c of targets(item.repositoryFullName)) { c.problems.total += 1; bump(c.problems.byKind, item.reasonCode); }
  if (pullRequests !== null) {
    const zero = (): PullRequestCounts => ({ open: 0, draft: 0, reviewWaiting: 0, mergeWaiting: 0, fixWaiting: 0, ciFailed: 0, conflict: 0, unknown: 0 });
    totals.pullRequests = prCounts;
    for (const name of visibleRepoNames) byRepository[name].pullRequests = zero();
    for (const pr of pullRequests.filter((p) => p.state === "open")) {
      const c = byRepository[pr.repositoryFullName]?.pullRequests;
      if (c) c.open += 1;
    }
    const field: Record<string, keyof PullRequestCounts> = {
      draft: "draft", "review-waiting": "reviewWaiting", "merge-waiting": "mergeWaiting", "fix-waiting": "fixWaiting",
      "ci-failed": "ciFailed", conflict: "conflict", unknown: "unknown",
    };
    for (const item of items.pullRequests) {
      const c = byRepository[item.repositoryFullName]?.pullRequests;
      const key = field[item.reasonCode];
      if (c && key) c[key] += 1;
    }
    // 確認待ちのPR件数（人のマージ待ち）
    totals.checkUser.pullRequests = prCounts?.mergeWaiting ?? null;
    for (const name of visibleRepoNames) byRepository[name].checkUser.pullRequests = byRepository[name].pullRequests?.mergeWaiting ?? null;
  }
  for (const item of items.deployment) {
    for (const c of targets(item.repositoryFullName)) {
      if (item.reasonCode === "awaiting-main") c.deployment.awaitingMainIssues += 1;
      else c.deployment.mainMergeInProgressIssues += 1;
    }
  }
  for (const item of items.recentCompletions) {
    for (const c of targets(item.repositoryFullName)) {
      c.recentCompletions.completedIssues += 1;
      if (item.reasonCode.startsWith("closed-")) c.recentCompletions.closedWithoutMainIssues += 1;
      else {
        c.recentCompletions.reachedMainIssues += 1;
        if (input.deployEvidence) {
          c.recentCompletions.deploySucceededIssues = (c.recentCompletions.deploySucceededIssues ?? 0) + (item.reasonCode === "deploy-succeeded" ? 1 : 0);
        }
      }
    }
  }
  if (input.deployEvidence) {
    totals.recentCompletions.deploySucceededIssues ??= 0;
    for (const name of visibleRepoNames) byRepository[name].recentCompletions.deploySucceededIssues ??= 0;
  }

  // 完了履歴の網羅性: キャッシュにある最古のcloseより前を含む期間は不完全
  const historyComplete =
    input.oldestClosedAtInCache !== null && input.period.from.getTime() >= input.oldestClosedAtInCache.getTime();
  const historyNote = historyComplete
    ? null
    : input.oldestClosedAtInCache === null
      ? "同期済みのclose済みIssueが無く、期間内の完了を判定できません（件数は下限）"
      : `同期済みIssueの最古のcloseは${input.oldestClosedAtInCache.toISOString()}で、指定期間の開始より新しいため件数は下限です`;

  if (prFailedRepos.size > 0) warnings.push(`PRを取得できなかったリポジトリ: ${[...prFailedRepos].sort().join(", ")}`);
  if (input.deployEvidence === null) warnings.push("デプロイの証拠（deploy.ymlの実行）は取得していません。デプロイ状態はunknownです");

  return {
    population: {
      repositories: visibleRepoNames.length,
      excludedArchived: [...archived].sort(),
      excludedHidden: [...hidden].sort(),
      issues: issues.length,
      snoozedIssues: [...snoozedIds].filter((id) => issueById.has(id)).length,
    },
    totals,
    byRepository,
    items,
    reservation: {
      queuedReservations: items.reserved.length,
      uniqueIssues: reservedIssueKeys.size,
      byAgent,
      enabled: input.nextWindow.enabled,
      windowPhase,
      windowOpensAt: input.nextWindow.window?.opensAt ?? null,
      blockers,
    },
    problems: { currentTotal: items.problems.length },
    pullRequestsAvailable: pullRequests !== null,
    recentCompletions: {
      from: input.period.from.toISOString(),
      to: input.period.to.toISOString(),
      historyComplete,
      historyNote,
    },
    overlapNotes: [
      "Issue・PR・ジョブ・予約は別の単位で、区分間で足し合わせない",
      "1つのIssueが複数の区分に載ることがある（例: 予約済みIssueは未着手から除外されるが、予約の区分には載る）",
      "PRの区分（reviewWaiting・mergeWaiting・fixWaiting・ciFailed・conflict・unknown）は重複しうる。openがPRの総数",
      "確認待ちのissuesは今対応できる数。エージェント稼働中のものはexcludedRunningに分ける",
      "手作業待ちのactionableIssuesは前提を満たすもののみ。前提待ちはwaitingForPrerequisitesIssues",
      "問題・停止は最新の実行ジョブ1件の状態のみ。閉じたIssue・後続ジョブがあるIssueは数えない",
    ],
    warnings,
  };
}

/** 画面の左メニューと同じ数え方で求めた件数。集計の一致検証（テスト）に使う */
export function computeScreenNavCounts(
  input: Pick<SummaryInput, "issues" | "repositories" | "currentUserLogin" | "snoozes" | "now">,
  reservedIssueIds: ReadonlySet<string>,
  runningIds: ReadonlySet<string>,
): Record<NavViewId, number> {
  const visible = new Set(input.repositories.filter((r) => !r.archived && !r.hidden).map((r) => r.fullName));
  const issues = input.issues.filter((i) => visible.has(i.repositoryFullName));
  return computeNavCountsForFilters(
    issues,
    DEFAULT_FILTERS,
    input.currentUserLogin,
    issues,
    runningIds,
    selectSnoozedIssueIds(issues, input.snoozes, input.now.getTime()),
    reservedIssueIds,
  );
}
