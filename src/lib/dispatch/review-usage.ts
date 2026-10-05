import { db } from "@/lib/db";
import { SESSION_USAGE_AGENTS, type SessionUsageAgent } from "@/lib/dispatch/session-usage";

/**
 * GitHub Actions以外で走るPRレビューの使用量（#3995）。
 *
 * 報告するのはサブPCの`scripts/start-codex-pr-review.sh`。Codex PRレビューは
 * `codex exec --ephemeral`で走るため`~/.codex/sessions`に転記が残らず、pollerの転記収集
 * （`/api/dispatch/session-usage`）では拾えない。`codex exec --json`が出す`turn.completed`の
 * usageだけを、実行1回（＝試行）ごとにここへ送る。
 *
 * **保存先は`SessionUsage`で、処理種別は`kind: "actions"`（画面の「CI/CD・レビュー」）。**
 * 実行場所は`source: "local"`と`host`で持ち、GitHub Actionsの実行として偽装しない。
 * エージェントは報告どおりに保存し、現在の設定値から推測しない。
 *
 * **使用量を取れなかった試行も1行として残す**（`responses: 0`・トークン0）。タイムアウト等で
 * `turn.completed`が出なかった実行を「実行なし」と見分けられるようにするため。画面は
 * `responses === 0`の行を「使用量の記録なし」と出し、$0として扱わない。
 *
 * **専用の受け口に分けた理由。** サブPCのスクリプトは`develop`から、受け口は本番（`main`）で動く。
 * 既存の`/session-usage`へ足すと、古い本番は新しい項目（PR番号・記録なしの行）を黙って捨てて
 * `200`を返すため、送った側は届いたと誤解して再送しない。新しいパスなら古い本番は`404`を返し、
 * 送り手は報告を手元に残してリリース後に送り直せる。
 */

const MAX_REPORTS_PER_REQUEST = 20;

export type ReviewUsageStatus = "completed" | "failed" | "timeout";

export type ReviewUsageReport = {
  agent: SessionUsageAgent;
  /** 処理の名前（例: `codex-pr-review`）。英小文字とハイフンだけ */
  process: string;
  /** 試行の識別子（Codexのthread_idなど）。同じ値の再送は同じ行へ上書きされる */
  attemptId: string;
  /** `owner/repo` */
  repository: string;
  prNumber: number;
  issueNumber: number | null;
  headSha: string;
  status: ReviewUsageStatus;
  /** 使用量が取れなかった試行はnull（画面は「使用量の記録なし」） */
  usage: {
    responses: number;
    inputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    /** 単価の分からないモデルはnull（保存は0、画面は「単価不明」） */
    costUsd: number | null;
    inputCostUsd: number | null;
    outputCostUsd: number | null;
  } | null;
  models: string[];
  /** 結果（PRコメント）のURL。明細から開くために持つ */
  resultUrl: string | null;
  startedAt: Date;
  endedAt: Date;
};

const PROCESS_LABELS: Record<string, string> = {
  "codex-pr-review": "Codex PRレビュー",
};

const STATUS_SUFFIX: Record<ReviewUsageStatus, string> = {
  completed: "",
  failed: "（失敗）",
  timeout: "（タイムアウト）",
};

function stringValue(value: unknown, max: number, pattern?: RegExp): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return pattern && !pattern.test(value) ? null : value;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = nonNegativeInteger(value);
  return parsed && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseUsage(value: unknown): ReviewUsageReport["usage"] | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const responses = positiveInteger(input.responses);
  const inputTokens = nonNegativeInteger(input.inputTokens);
  const cacheCreateTokens = nonNegativeInteger(input.cacheCreateTokens);
  const cacheReadTokens = nonNegativeInteger(input.cacheReadTokens);
  const outputTokens = nonNegativeInteger(input.outputTokens);
  if (responses === null || inputTokens === null || cacheCreateTokens === null || cacheReadTokens === null || outputTokens === null) {
    return undefined;
  }
  const costUsd = input.costUsd === null || input.costUsd === undefined ? null : nonNegativeNumber(input.costUsd);
  if (costUsd === null && input.costUsd !== null && input.costUsd !== undefined) return undefined;
  const inputCostUsd = nonNegativeNumber(input.inputCostUsd);
  const outputCostUsd = nonNegativeNumber(input.outputCostUsd);
  const hasSplit = costUsd !== null && inputCostUsd !== null && outputCostUsd !== null;
  return {
    responses,
    inputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    outputTokens,
    costUsd,
    inputCostUsd: hasSplit ? inputCostUsd : null,
    outputCostUsd: hasSplit ? outputCostUsd : null,
  };
}

export function parseReviewUsageReport(value: unknown): ReviewUsageReport | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const agent = input.agent;
  if (typeof agent !== "string" || !SESSION_USAGE_AGENTS.includes(agent as SessionUsageAgent)) return null;
  const process = stringValue(input.process, 64, /^[a-z][a-z0-9-]*$/);
  const attemptId = stringValue(input.attemptId, 64, /^[A-Za-z0-9._-]+$/);
  const repository = stringValue(input.repository, 191, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const headSha = stringValue(input.headSha, 64, /^[0-9a-f]{7,64}$/);
  const prNumber = positiveInteger(input.prNumber);
  const status = input.status;
  const startedAt = timestamp(input.startedAt);
  const endedAt = timestamp(input.endedAt);
  const models = input.models;
  if (
    !process || !attemptId || !repository || !headSha || prNumber === null || !startedAt || !endedAt ||
    (status !== "completed" && status !== "failed" && status !== "timeout") ||
    !Array.isArray(models) || models.some((model) => typeof model !== "string" || model.length > 64)
  ) {
    return null;
  }
  const rawIssue = input.issueNumber;
  const issueNumber = rawIssue === null || rawIssue === undefined ? null : positiveInteger(rawIssue);
  if (rawIssue !== null && rawIssue !== undefined && issueNumber === null) return null;
  const usage = parseUsage(input.usage);
  if (usage === undefined) return null;
  const resultUrl = stringValue(input.resultUrl, 500, /^https:\/\//);
  return {
    agent: agent as SessionUsageAgent,
    process,
    attemptId,
    repository,
    prNumber,
    issueNumber,
    headSha,
    status,
    usage,
    models: models as string[],
    resultUrl,
    startedAt,
    endedAt,
  };
}

export function parseReviewUsagePayload(value: unknown): { reports: ReviewUsageReport[]; skipped: number } | null {
  if (!value || typeof value !== "object") return null;
  const reports = (value as Record<string, unknown>).reports;
  if (!Array.isArray(reports) || reports.length > MAX_REPORTS_PER_REQUEST) return null;
  const parsed = reports.map(parseReviewUsageReport);
  return {
    reports: parsed.filter((report): report is ReviewUsageReport => report !== null),
    skipped: parsed.filter((report) => report === null).length,
  };
}

/** 一意キー。**試行ごと**に分け、同じ試行の再送だけを同じ行へ寄せる */
export function reviewUsageSessionId(report: Pick<ReviewUsageReport, "process" | "repository" | "prNumber" | "headSha" | "attemptId">): string {
  return `${report.process}:${report.repository}#${report.prNumber}@${report.headSha.slice(0, 12)}:${report.attemptId}`.slice(0, 191);
}

export function reviewUsageWorkflowName(report: Pick<ReviewUsageReport, "process" | "status">): string {
  return `${PROCESS_LABELS[report.process] ?? report.process}${STATUS_SUFFIX[report.status]}`;
}

export async function storeReviewUsage({
  hostName,
  reports,
  reportedAt = new Date(),
}: {
  hostName: string;
  reports: ReviewUsageReport[];
  reportedAt?: Date;
}): Promise<number> {
  for (const report of reports) {
    const sessionId = reviewUsageSessionId(report);
    const usage = report.usage;
    const data = {
      source: "local",
      kind: "actions",
      // 転記は無い（ephemeral実行）。手元で辿れるよう対象だけを書く
      transcript: `${report.process}:${report.repository}#${report.prNumber}@${report.headSha}`,
      repository: report.repository.split("/").at(-1) ?? report.repository,
      issueNumber: report.issueNumber,
      prNumber: report.prNumber,
      workflowName: reviewUsageWorkflowName(report),
      runUrl: report.resultUrl,
      responses: usage?.responses ?? 0,
      inputTokens: BigInt(usage?.inputTokens ?? 0),
      cacheCreate5mTokens: BigInt(usage?.cacheCreateTokens ?? 0),
      cacheCreate1hTokens: BigInt(0),
      cacheReadTokens: BigInt(usage?.cacheReadTokens ?? 0),
      outputTokens: BigInt(usage?.outputTokens ?? 0),
      // 単価不明は0で保存し、画面が「トークンがあるのに$0」を単価不明として出す
      costUsd: usage?.costUsd ?? 0,
      inputCostUsd: usage?.inputCostUsd ?? null,
      outputCostUsd: usage?.outputCostUsd ?? null,
      models: JSON.stringify(report.models),
      startedAt: report.startedAt,
      endedAt: report.endedAt,
      reportedAt,
    };
    await db.sessionUsage.upsert({
      where: { host_agent_sessionId: { host: hostName, agent: report.agent, sessionId } },
      create: { host: hostName, agent: report.agent, sessionId, ...data },
      update: data,
    });
  }
  return reports.length;
}
