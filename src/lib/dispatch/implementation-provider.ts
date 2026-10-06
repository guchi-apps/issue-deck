import { db } from "@/lib/db";
import { parseDispatchAgent, type DispatchAgent } from "@/lib/dispatch/dispatch-job";

type Run = { agent: string; startedAt: Date; source: string };

/** 同時刻の異なる担当は推測しない。共通設定や生存報告の更新時刻は参照しない。 */
export function selectImplementationProvider(runs: readonly Run[]): DispatchAgent | null {
  if (!runs.length) return null;
  const latest = Math.max(...runs.map((run) => run.startedAt.getTime()));
  const agents = new Set(runs.filter((run) => run.startedAt.getTime() === latest).map((run) => run.agent));
  if (agents.size !== 1) return null;
  return parseDispatchAgent([...agents][0]);
}

export async function recordImplementationRun(input: {
  repositoryFullName: string;
  issueNumber: number;
  runKey: string;
  agent: DispatchAgent;
  source: "local" | "actions";
  startedAt: Date;
}) {
  // 再送は開始時刻を変えない。ローカルはthread情報の後着を同じ開始記録へ反映する。
  // Actionsの実行キーへ別担当を上書きすることは許さない。
  const stored = await db.implementationRun.upsert({
    where: { runKey: input.runKey }, create: input, update: input.source === "local" ? { agent: input.agent } : {},
  });
  if (stored.agent !== input.agent || stored.repositoryFullName !== input.repositoryFullName || stored.issueNumber !== input.issueNumber) {
    throw new Error("implementation_run_conflict");
  }
}

export async function resolveImplementationProvider(repositoryFullName: string, issueNumber: number) {
  const runs = await db.implementationRun.findMany({
    where: { repositoryFullName, issueNumber }, orderBy: { startedAt: "desc" },
  });
  // 移行前の実装も、残っているセッションの記録で解決する。使用量からは推測しない。
  const sessions = await db.dispatchSession.findMany({
    where: { repositoryFullName, issueNumber },
    select: { codexThreadKnown: true, firstSeenAt: true, activity: true },
  });
  const candidates: Run[] = [...runs, ...sessions
    .filter((session) => session.activity !== "NOT_STARTED")
    .map((session) => ({ agent: session.codexThreadKnown === null ? "claude" : "codex", startedAt: session.firstSeenAt, source: "local" }))];
  return selectImplementationProvider(candidates);
}
