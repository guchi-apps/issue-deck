import { db } from "@/lib/db";

/**
 * 「修正を自動で続ける」（リリース完了系列・#4480）が動いている間の修正Issueを引く（#5138）。ブランチ一覧・PR一覧で、
 * その修正PRに残った確認待ち（系列が止まったときに付けたもの）を「ユーザー確認待ち」と見せず、自動で進行中と出すのに使う。
 *
 * GitHub APIは使わず、DBを2クエリ引くだけ。系列が止まった（`activeKey`が外れた）ら対象から外れ、従来の表示に戻る。
 */

export function releaseAutoFixKey(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}

/** 修正Issue（`owner/repo#番号`）→ 系列がいま見ている候補の番号 */
export async function fetchReleaseAutoFixIssues(repositoryFullNames: readonly string[]): Promise<Map<string, { candidatePrNumber: number }>> {
  const result = new Map<string, { candidatePrNumber: number }>();
  if (repositoryFullNames.length === 0) return result;
  const runs = await db.releaseCompletionRun.findMany({
    where: { activeKey: { not: null }, repositoryFullName: { in: [...new Set(repositoryFullNames)] } },
    select: { repositoryFullName: true, candidatePrNumber: true, candidatePrNumbers: true },
  });
  if (runs.length === 0) return result;
  const series = await db.releaseFixSeries.findMany({
    where: {
      OR: runs.map((run) => ({
        repositoryFullName: run.repositoryFullName,
        releasePrNumber: { in: [...new Set([run.candidatePrNumber, ...numbers(run.candidatePrNumbers)])] },
      })),
    },
    select: { repositoryFullName: true, releasePrNumber: true, issueNumber: true },
  });
  for (const row of series) {
    const run = runs.find(
      (r) => r.repositoryFullName === row.repositoryFullName && (r.candidatePrNumber === row.releasePrNumber || numbers(r.candidatePrNumbers).includes(row.releasePrNumber)),
    );
    if (run) result.set(releaseAutoFixKey(row.repositoryFullName, row.issueNumber), { candidatePrNumber: run.candidatePrNumber });
  }
  return result;
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n)) : [];
}
