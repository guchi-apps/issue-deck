import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { fetchClaudeUsage } from "@/lib/claude/usage";
import { db } from "@/lib/db";
import { getLatestCodexUsage } from "@/lib/dispatch/codex-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import {
  buildSessionUsageSummary,
  sessionUsagePeriodStartMs,
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
 * GitHub APIへ都度問い合わせる——この画面は自動更新を持たず手動更新のみ（`use-session-usage.ts`）
 * なので、都度取得でもレート制限への影響は小さい。
 *
 * **リポジトリの突き合わせは`SessionUsage.repository`が持つ「ownerを除いた短い名前」でしか
 * 行えない**（`issue-deck-shell.tsx`の`openUsageIssue`と同じ前提）。取得できなかった行は
 * `title`をnullのままにし、画面は番号のみの表示にフォールバックする。
 */
async function resolveIssueTitles(issues: UsageIssue[]): Promise<void> {
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

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const days = parseDays(request.nextUrl.searchParams.get("days"));
  const nowMs = Date.now();
  const periodStartMs = sessionUsagePeriodStartMs(nowMs, days);

  const rows = await db.sessionUsage.findMany({
    where: { endedAt: { gte: new Date(periodStartMs) } },
    orderBy: { endedAt: "desc" },
    select: {
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
      wrapupCostUsd: true,
      runUrl: true,
      reportedAt: true,
    },
  });

  const entries = rows.map(toEntry);
  const reportedAt = rows.reduce<Date | null>((latest, row) => {
    return latest === null || row.reportedAt > latest ? row.reportedAt : latest;
  }, null);

  // **プラン枠の取得に失敗しても画面は出す。** 非公開のヘッダに依存しているので、
  // 取れない日があっても「メーターが出ないだけ」で済ませる（設定画面と同じ扱い）。
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const [claudePlanUsage, codexPlanUsage] = await Promise.all([
    token ? fetchClaudeUsage(token).catch(() => null) : Promise.resolve(null),
    getLatestCodexUsage().catch(() => null),
  ]);

  const summary = buildSessionUsageSummary({
    entries,
    nowMs,
    days,
    reportedAt: reportedAt?.toISOString() ?? null,
  });

  await resolveIssueTitles(summary.byIssue);

  return NextResponse.json(
    {
      ...summary,
      planUsage: { claude: claudePlanUsage, codex: codexPlanUsage },
      planNotConfigured: { claude: !token, codex: !codexPlanUsage },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
