import { db } from "@/lib/db";
import { toReleaseCandidateFix, type ReleaseCandidateFix } from "@/lib/release-fix-series";

/**
 * リリース候補PRに対する最新の修正系列から、候補に出す修正の状態を引く（#4972）。
 * 作り直しで候補PRが替わるため、起点のPRと作り直し後のPRの両方で探す。DBだけを読む
 */
export async function loadReleaseCandidateFixes(
  targets: { repositoryFullName: string; number: number }[],
): Promise<Map<string, ReleaseCandidateFix>> {
  const result = new Map<string, ReleaseCandidateFix>();
  if (targets.length === 0) return result;
  const rows = await db.releaseFixSeries.findMany({
    where: {
      OR: targets.flatMap((t) => [
        { repositoryFullName: t.repositoryFullName, releasePrNumber: t.number },
        { repositoryFullName: t.repositoryFullName, successorPrNumber: t.number },
      ]),
    },
    orderBy: { createdAt: "desc" },
    select: {
      repositoryFullName: true,
      releasePrNumber: true,
      successorPrNumber: true,
      status: true,
      issueNumber: true,
      sourceKind: true,
      stopReason: true,
      internalStopReason: true,
    },
  });
  for (const target of targets) {
    const latest = rows.find(
      (row) =>
        row.repositoryFullName === target.repositoryFullName &&
        (row.releasePrNumber === target.number || row.successorPrNumber === target.number),
    );
    const fix = latest ? toReleaseCandidateFix(latest) : null;
    if (fix) result.set(`${target.repositoryFullName}#${target.number}`, fix);
  }
  return result;
}
