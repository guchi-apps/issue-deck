import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { fetchClaudeUsage, peekClaudeUsageWindows, type ClaudeUsageWindow } from "@/lib/claude/usage";
import { db } from "@/lib/db";
import { getCodexUsage } from "@/lib/dispatch/codex-usage";
import {
  describeSessionStep,
  isSessionStepFresh,
  resolveIssueImplementationAgent,
  summarizeIssueSession,
} from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { listDispatchSessions } from "@/lib/dispatch/sessions";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import {
  buildIssueQuotaPercents,
  buildCurrentSessionUsage,
  buildQuotaEstimate,
  buildSessionUsageSummary,
  sessionUsageIssueKey,
  sessionUsagePeriodStartMs,
  type CurrentSessionInput,
  type CurrentSessionUsage,
  type QuotaEstimate,
  type SessionUsageEntry,
  type UsageIssue,
} from "@/lib/session-usage-view";

/**
 * 「AI使用量」画面（#2504）が読む集計。
 *
 * **materialはサブPCのpollerが押し込んだ`SessionUsage`の行だけ**で、ここから転記を読みには
 * 行かない（本番のissue-deckは転記を持たない）。
 *
 * **プラン枠のメーターも一緒に返す。** 画面が`/api/claude/usage`を別に叩くと取得が2本走る。
 * 取得は`lib/claude/usage.ts`が5分キャッシュしているので、設定画面と同時に開いても
 * プラン枠を余分に消費しない。
 */

/** 画面に出す期間の選択肢（日）。今日を含む */
const ALLOWED_DAYS = [1, 7, 30] as const;
const DEFAULT_DAYS = 7;

function parseDays(value: string | null): number {
  const parsed = Number(value);
  return (ALLOWED_DAYS as readonly number[]).includes(parsed) ? parsed : DEFAULT_DAYS;
}

/** `toEntry`が読む列。期間の集計と実行中のセッション（#3084）の両方で同じ形に揃える */
const SESSION_USAGE_SELECT = {
  sessionId: true,
  agent: true,
  source: true,
  host: true,
  kind: true,
  repository: true,
  issueNumber: true,
  prNumber: true,
  responses: true,
  inputTokens: true,
  cacheCreate5mTokens: true,
  cacheCreate1hTokens: true,
  cacheReadTokens: true,
  outputTokens: true,
  costUsd: true,
  inputCostUsd: true,
  outputCostUsd: true,
  planCostUsd: true,
  implementationCostUsd: true,
  models: true,
  startedAt: true,
  endedAt: true,
  workflowName: true,
  researchCostUsd: true,
  codingCostUsd: true,
  verifyCostUsd: true,
  wrapupCostUsd: true,
  runUrl: true,
  reportedAt: true,
} as const;

/** DBの行（BigInt）を、そのままJSONにできる形へ落とす */
function toEntry(row: {
  agent: string;
  source: string;
  sessionId: string;
  host: string;
  kind: string;
  repository: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  responses: number;
  inputTokens: bigint;
  cacheCreate5mTokens: bigint;
  cacheCreate1hTokens: bigint;
  cacheReadTokens: bigint;
  outputTokens: bigint;
  costUsd: number;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  planCostUsd: number | null;
  implementationCostUsd: number | null;
  researchCostUsd: number | null;
  codingCostUsd: number | null;
  verifyCostUsd: number | null;
  wrapupCostUsd: number | null;
  models: string;
  startedAt: Date;
  endedAt: Date;
  workflowName: string | null;
  runUrl: string | null;
}): SessionUsageEntry {
  const inputTokens = Number(row.inputTokens);
  const cacheCreateTokens = Number(row.cacheCreate5mTokens) + Number(row.cacheCreate1hTokens);
  const cacheReadTokens = Number(row.cacheReadTokens);

  // モデルの配列は報告時にJSONで入れている。壊れていても行ごと落とさず空扱いにする。
  let models: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.models);
    if (Array.isArray(parsed)) models = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    models = [];
  }

  const hasPhaseCosts =
    row.researchCostUsd !== null && row.codingCostUsd !== null && row.wrapupCostUsd !== null;

  return {
    agent: row.agent === "codex" ? "codex" : "claude",
    source: row.source === "github-actions" ? "github-actions" : "local",
    sessionId: row.sessionId,
    host: row.host,
    kind: row.kind,
    repository: row.repository,
    issueNumber: row.issueNumber,
    prNumber: row.prNumber,
    responses: row.responses,
    inputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    outputTokens: Number(row.outputTokens),
    contextTokens: inputTokens + cacheCreateTokens + cacheReadTokens,
    costUsd: row.costUsd,
    // 内訳は集計側が単価から割ったものをそのまま渡す（#2626）。片方だけの行は内訳なしとして扱う。
    inputCostUsd: row.inputCostUsd !== null && row.outputCostUsd !== null ? row.inputCostUsd : null,
    outputCostUsd: row.inputCostUsd !== null && row.outputCostUsd !== null ? row.outputCostUsd : null,
    // 計画/実装の内訳（#2646）。片方だけの行は区分なしとして扱う。
    planCostUsd:
      row.planCostUsd !== null && row.implementationCostUsd !== null ? row.planCostUsd : null,
    implementationCostUsd:
      row.planCostUsd !== null && row.implementationCostUsd !== null
        ? row.implementationCostUsd
        : null,
    // 実装の中の4区分（#2779）。**3つ揃っている行だけ**を内訳ありとして渡す。
    researchCostUsd: hasPhaseCosts ? row.researchCostUsd : null,
    codingCostUsd: hasPhaseCosts ? row.codingCostUsd : null,
    wrapupCostUsd: hasPhaseCosts ? row.wrapupCostUsd : null,
    // 検証（#3064）。この列より前の行はnullで、画面は0として扱う（実装・仕上げに含まれたまま）。
    verifyCostUsd: hasPhaseCosts ? row.verifyCostUsd : null,
    models,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    workflowName: row.workflowName,
    runUrl: row.runUrl,
  };
}

/**
 * 「Issue・PR別」一覧のタイトル解決（#2686）。**この関数だけがDBの`Issue`テーブル・GitHub APIを
 * 読む**——`buildSessionUsageSummary`はDBを読まない純粋関数のままにするため、集計後にここで
 * `issue.title`を詰め直す。
 *
 * issueNumberを持つ行はDBの`Issue`テーブル（Issue一覧画面向けに既に同期済み）から引くだけで、
 * 追加のAPI消費が無い。**issueNumberを持たないPR単体の行（developへのPRレビュー等）だけ**
 * GitHub APIへ都度問い合わせる——期間の集計は自動更新を持たず手動更新のみ（`use-session-usage.ts`）
 * なので、都度取得でもレート制限への影響は小さい。20秒おきに取り直す実行中のセッション（#3135）は
 * 必ずissueNumberを持つため、この経路でGitHub APIを呼ばない。
 *
 * **リポジトリの突き合わせは`SessionUsage.repository`が持つ「ownerを除いた短い名前」でしか
 * 行えない**（`issue-deck-shell.tsx`の`openUsageIssue`と同じ前提）。取得できなかった行は
 * `title`をnullのままにし、画面は番号のみの表示にフォールバックする。
 */
async function resolveIssueTitles(
  issues: Pick<UsageIssue, "repository" | "issueNumber" | "prNumber" | "title">[],
): Promise<void> {
  const repositoryNames = [
    ...new Set(issues.flatMap((issue) => (issue.repository ? [issue.repository] : []))),
  ];
  if (repositoryNames.length === 0) return;

  const repositories = await db.repository.findMany({
    where: { name: { in: repositoryNames } },
    select: {
      id: true,
      name: true,
      ownerLogin: true,
      installation: { select: { installationId: true } },
    },
  });
  const repositoryByName = new Map(repositories.map((repository) => [repository.name, repository]));

  // issueNumberを持つ行はDBの同期済みIssueテーブルから引く（追加のAPI消費なし）。
  const repositoryIds = repositories.map((repository) => repository.id);
  const issueNumbers = issues.flatMap((issue) => (issue.issueNumber !== null ? [issue.issueNumber] : []));
  const dbIssues =
    repositoryIds.length > 0 && issueNumbers.length > 0
      ? await db.issue.findMany({
          where: { repositoryId: { in: repositoryIds }, number: { in: issueNumbers } },
          select: { repositoryId: true, number: true, title: true },
        })
      : [];
  const titleByRepoIdAndNumber = new Map(
    dbIssues.map((row) => [`${row.repositoryId}#${row.number}`, row.title]),
  );

  for (const issue of issues) {
    if (issue.issueNumber === null || !issue.repository) continue;
    const repository = repositoryByName.get(issue.repository);
    if (!repository) continue;
    issue.title = titleByRepoIdAndNumber.get(`${repository.id}#${issue.issueNumber}`) ?? null;
  }

  // issueNumberを持たないPR単体の行だけ、GitHub APIへ都度問い合わせる。
  // 同一installationのリポジトリ間でトークン取得を使い回す（`conflict-sweep-run.ts`と同じ）。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const prIssues = issues.filter(
    (issue) => issue.issueNumber === null && issue.prNumber !== null && issue.repository,
  );
  await Promise.all(
    prIssues.map(async (issue) => {
      const repository = repositoryByName.get(issue.repository as string);
      if (!repository) return;
      try {
        const token = await tokenFor(repository.installation.installationId);
        const pullRequest = await fetchPullRequest(
          repository.ownerLogin,
          repository.name,
          issue.prNumber as number,
          token,
        );
        issue.title = pullRequest.title;
      } catch (error) {
        // タイトルが無くても使用量本体（金額・トークン）の表示は止めない（#2686）。
        console.error(
          `[session-usage] PRタイトルの取得に失敗: ${issue.repository}#${issue.prNumber}`,
          error,
        );
      }
    }),
  );
}

/** 状態のピルの色分け。文言は実行状況パネルと同じ`summarizeIssueSession`から作る */
function toCurrentSessionInput(session: DispatchSessionView, now: Date): CurrentSessionInput {
  const summary = summarizeIssueSession(session);
  const step = describeSessionStep(session, now);
  const statusTone =
    summary.tone === "waiting"
      ? "waiting"
      : session.activity === "RESPONDED" && !isSessionStepFresh(session)
        ? "idle"
        : "running";
  return {
    host: session.host,
    tmuxSessionName: session.tmuxSessionName,
    repositoryFullName: session.repositoryFullName,
    issueNumber: session.issueNumber,
    firstSeenAt: session.firstSeenAt,
    agent: resolveIssueImplementationAgent(session),
    statusLabel: step
      ? `${summary.shortLabel}・${step.label}${step.since ? ` ${step.since}` : ""}`
      : summary.shortLabel,
    statusTone,
    models: session.models,
  };
}

/**
 * 「実行中のセッション」欄（#3084）。**いまサブPCで生きているセッション（実行状況パネルと同じ
 * `DispatchSession`のALIVE）ごとに、始まってからの使用量を返す。**
 *
 * 期間（`days`）には連動しない。セッションが期間の開始より前に立っていることがあるため、
 * 期間の集計とは別に、生きているセッションに当たる行だけをもう1度引く。
 *
 * **失敗しても画面の残りは出す**（空配列を返す）。本体は期間の集計で、ここは添え物。
 */
async function listCurrentSessionUsage(
  now: Date,
  quota: QuotaEstimate | null,
): Promise<CurrentSessionUsage[]> {
  try {
    const alive = (await listDispatchSessions(now)).filter((session) => session.state === "ALIVE");
    if (alive.length === 0) return [];

    const earliest = alive.reduce(
      (oldest, session) => (session.firstSeenAt < oldest ? session.firstSeenAt : oldest),
      alive[0].firstSeenAt,
    );
    const rows = await db.sessionUsage.findMany({
      where: {
        source: "local",
        kind: "implementation",
        endedAt: { gte: new Date(earliest) },
        OR: alive.map((session) => ({
          host: session.host,
          repository: session.repositoryFullName.split("/")[1] ?? session.repositoryFullName,
          issueNumber: session.issueNumber,
        })),
      },
      select: SESSION_USAGE_SELECT,
    });

    const current = buildCurrentSessionUsage({
      sessions: alive.map((session) => toCurrentSessionInput(session, now)),
      entries: rows.map(toEntry),
      quota,
    });
    await resolveIssueTitles(current);
    return current;
  } catch (error) {
    console.error("[session-usage] 実行中のセッションの集計に失敗", error);
    return [];
  }
}

/**
 * 5時間枠の実測換算（#2988）。`entries`はウィンドウの開始以降のClaudeの行を含んでいること。
 * 期間の集計と実行中のセッションだけの取得（#3135）の両方が使う。
 */
function quotaEstimateOf(
  fiveHourWindow: ClaudeUsageWindow | null,
  entries: Pick<SessionUsageEntry, "agent" | "costUsd" | "endedAt">[],
): QuotaEstimate | null {
  return fiveHourWindow
    ? buildQuotaEstimate({
        entries,
        usedPercent: fiveHourWindow.usedPercent,
        resetsAt: fiveHourWindow.resetsAt,
        windowDurationMs: fiveHourWindow.durationMs,
      })
    : null;
}

/**
 * 実行中のセッションだけを返す（`?current=1`。#3135）。画面は「AI使用量」を開いている間、
 * これを20秒おきに呼んで「実行中のセッション」欄だけを新しくする。
 *
 * **プラン枠は取得しない。** 取得は最小の推論リクエストで、送信そのものが枠を消費・開始する
 * （`lib/claude/usage.ts`）。5時間枠の換算には、画面を開いたときの取得が残したキャッシュを
 * 読むだけにする（無ければ換算なし＝割合を出さない）。期間の集計・Issue別の一覧も作らない。
 */
async function getCurrentOnly(): Promise<NextResponse> {
  const now = new Date();
  const fiveHourWindow = peekClaudeUsageWindows()?.find((w) => w.key === "5h") ?? null;
  let quotaEstimate: QuotaEstimate | null = null;
  if (fiveHourWindow?.resetsAt != null) {
    const windowStartMs = fiveHourWindow.resetsAt * 1000 - fiveHourWindow.durationMs;
    const windowRows = await db.sessionUsage.findMany({
      where: { agent: "claude", endedAt: { gte: new Date(windowStartMs) } },
      select: { agent: true, costUsd: true, endedAt: true },
    });
    quotaEstimate = quotaEstimateOf(
      fiveHourWindow,
      windowRows.map((row) => ({
        agent: row.agent === "codex" ? "codex" : "claude",
        costUsd: row.costUsd,
        endedAt: row.endedAt.toISOString(),
      })),
    );
  }

  const currentSessions = await listCurrentSessionUsage(now, quotaEstimate);
  return NextResponse.json({ currentSessions }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (request.nextUrl.searchParams.get("current") === "1") {
    return getCurrentOnly();
  }

  const days = parseDays(request.nextUrl.searchParams.get("days"));
  const nowMs = Date.now();
  const periodStartMs = sessionUsagePeriodStartMs(nowMs, days);

  // **プラン枠の取得に失敗しても画面は出す。** 非公開のヘッダに依存しているので、
  // 取れない日があっても「メーターが出ないだけ」で済ませる（設定画面と同じ扱い）。
  // **DB取得より先に呼ぶ**（#2988）。5時間枠のウィンドウ開始（`resetsAt - durationMs`）が
  // 期間の開始（`periodStartMs`）より前へはみ出すことがあり（「1日」は日本時間0:00始まりなので、
  // 深夜〜早朝に開くとウィンドウの前半が前日にかかる）、そのぶんも取得範囲へ含める必要がある。
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const [claudePlanUsage, codexPlanUsage] = await Promise.all([
    token ? fetchClaudeUsage(token).catch(() => null) : Promise.resolve(null),
    getCodexUsage().catch(() => null),
  ]);

  const fiveHourWindow = claudePlanUsage?.windows.find((w) => w.key === "5h") ?? null;
  const quotaWindowStartMs =
    fiveHourWindow?.resetsAt !== null && fiveHourWindow?.resetsAt !== undefined
      ? fiveHourWindow.resetsAt * 1000 - fiveHourWindow.durationMs
      : null;
  const fetchStartMs =
    quotaWindowStartMs !== null ? Math.min(periodStartMs, quotaWindowStartMs) : periodStartMs;

  const rows = await db.sessionUsage.findMany({
    where: { endedAt: { gte: new Date(fetchStartMs) } },
    orderBy: { endedAt: "desc" },
    select: SESSION_USAGE_SELECT,
  });

  const entries = rows.map(toEntry);
  // **「いちばん新しい報告」は期間内の行だけで見る。** `rows`は5時間枠のウィンドウぶん
  // 期間の外まで広げて取得しているため、そのまま最大値を取ると期間の意味とずれる。
  const reportedAt = rows.reduce<Date | null>((latest, row) => {
    if (row.endedAt.getTime() < periodStartMs) return latest;
    return latest === null || row.reportedAt > latest ? row.reportedAt : latest;
  }, null);

  const summary = buildSessionUsageSummary({
    entries,
    nowMs,
    days,
    reportedAt: reportedAt?.toISOString() ?? null,
  });

  await resolveIssueTitles(summary.byIssue);

  // 5時間枠の実測換算（#2988）。`entries`は取得範囲を広げてあるぶん、期間の外（だがウィンドウ内）
  // の行も含む——`buildQuotaEstimate`・`buildIssueQuotaPercents`はどちらもそれを前提にしている。
  const quotaEstimate = quotaEstimateOf(fiveHourWindow, entries);
  const quotaPercentByIssueKey = buildIssueQuotaPercents(entries, quotaEstimate);
  for (const issue of summary.byIssue) {
    issue.quotaPercent = quotaPercentByIssueKey.get(sessionUsageIssueKey(issue)) ?? null;
  }

  const currentSessions = await listCurrentSessionUsage(new Date(nowMs), quotaEstimate);

  return NextResponse.json(
    {
      ...summary,
      planUsage: { claude: claudePlanUsage, codex: codexPlanUsage },
      planNotConfigured: { claude: !token, codex: !codexPlanUsage },
      quotaEstimate,
      currentSessions,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
