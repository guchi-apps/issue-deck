import { db } from "@/lib/db";

const MAX_REPORTS_PER_REQUEST = 20;
export const ACTIONS_USAGE_RETENTION_DAYS = 180;

export type ActionsUsageReport = {
  repository: string;
  runId: string;
  runUrl: string | null;
  workflowName: string | null;
  issueNumber: number | null;
  stepName: string;
  responses: number;
  inputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  models: string[];
  startedAt: Date;
  endedAt: Date;
};

function stringValue(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseActionsUsageReport(value: unknown): ActionsUsageReport | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const repository = stringValue(input.repository, 191);
  const runId = stringValue(input.runId, 191);
  const stepName = stringValue(input.stepName, 191);
  const startedAt = timestamp(input.startedAt);
  const endedAt = timestamp(input.endedAt);
  const responses = nonNegativeInteger(input.responses);
  const inputTokens = nonNegativeInteger(input.inputTokens);
  const cacheCreateTokens = nonNegativeInteger(input.cacheCreateTokens);
  const cacheReadTokens = nonNegativeInteger(input.cacheReadTokens);
  const outputTokens = nonNegativeInteger(input.outputTokens);
  const costUsd = input.costUsd;
  const models = input.models;
  if (!repository || !runId || !stepName || !startedAt || !endedAt || responses === null || responses === 0 || inputTokens === null || cacheCreateTokens === null || cacheReadTokens === null || outputTokens === null || typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0 || !Array.isArray(models) || models.some((model) => typeof model !== "string")) return null;
  const rawIssue = input.issueNumber;
  const issueNumber = rawIssue === null || rawIssue === undefined ? null : nonNegativeInteger(rawIssue);
  if (rawIssue !== null && rawIssue !== undefined && (!issueNumber || issueNumber <= 0)) return null;
  return {
    repository,
    runId,
    runUrl: stringValue(input.runUrl, 500),
    workflowName: stringValue(input.workflowName, 191),
    issueNumber,
    stepName,
    responses,
    inputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    outputTokens,
    costUsd,
    models: models as string[],
    startedAt,
    endedAt,
  };
}

export function parseActionsUsagePayload(value: unknown): ActionsUsageReport[] | null {
  if (!value || typeof value !== "object") return null;
  const reports = (value as Record<string, unknown>).reports;
  if (!Array.isArray(reports) || reports.length > MAX_REPORTS_PER_REQUEST) return null;
  return reports.map(parseActionsUsageReport).filter((report): report is ActionsUsageReport => report !== null);
}

export async function storeActionsUsage(reports: ActionsUsageReport[], reportedAt = new Date()): Promise<number> {
  for (const report of reports) {
    const sessionId = `actions:${report.repository}:${report.runId}:${report.stepName}`.slice(0, 191);
    await db.sessionUsage.upsert({
      where: { host_agent_sessionId: { host: "github-actions", agent: "claude", sessionId } },
      create: {
        host: "github-actions", agent: "claude", source: "github-actions", sessionId,
        transcript: report.runUrl ?? "github-actions", kind: "actions",
        repository: report.repository.split("/").at(-1) ?? report.repository,
        issueNumber: report.issueNumber, workflowName: report.workflowName, runUrl: report.runUrl,
        responses: report.responses, inputTokens: BigInt(report.inputTokens),
        cacheCreate5mTokens: BigInt(report.cacheCreateTokens), cacheCreate1hTokens: BigInt(0),
        cacheReadTokens: BigInt(report.cacheReadTokens), outputTokens: BigInt(report.outputTokens),
        costUsd: report.costUsd, models: JSON.stringify(report.models), startedAt: report.startedAt,
        endedAt: report.endedAt, reportedAt,
      },
      update: {
        transcript: report.runUrl ?? "github-actions", workflowName: report.workflowName, runUrl: report.runUrl,
        issueNumber: report.issueNumber, responses: report.responses, inputTokens: BigInt(report.inputTokens),
        cacheCreate5mTokens: BigInt(report.cacheCreateTokens), cacheReadTokens: BigInt(report.cacheReadTokens),
        outputTokens: BigInt(report.outputTokens), costUsd: report.costUsd, models: JSON.stringify(report.models),
        startedAt: report.startedAt, endedAt: report.endedAt, reportedAt,
      },
    });
  }
  const cutoff = new Date(Date.now() - ACTIONS_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.sessionUsage.deleteMany({ where: { source: "github-actions", endedAt: { lt: cutoff } } });
  return reports.length;
}
