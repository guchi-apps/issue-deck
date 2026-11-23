import { db } from "@/lib/db";
import { isReleaseCompletionActive, releaseCompletionStatusLabel } from "@/lib/release-completion";
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

/**
 * リリース候補PR（現在のhead）を追っている、進行中の「修正の自動継続」（`ReleaseCompletionRun`）を引く（#5614）。
 * 修正系列（修正Issue）ができる前の「原因を調査中」の間も、工程の表示が要確認を人の判断の番に見せないために使う。
 * 公開承認から始めた系列（`publishApprovalId`付き）は修正を起案しないので含めない。DBだけを読む
 */
export async function loadReleaseCandidateCompletions(
  targets: { repositoryFullName: string; number: number; headSha: string }[],
): Promise<Map<string, { status: string; label: string }>> {
  const result = new Map<string, { status: string; label: string }>();
  if (targets.length === 0) return result;
  const rows = await db.releaseCompletionRun.findMany({
    where: {
      activeKey: { not: null },
      publishApprovalId: null,
      stoppedAt: null,
      OR: targets.map((t) => ({ repositoryFullName: t.repositoryFullName, candidatePrNumber: t.number })),
    },
    orderBy: { createdAt: "desc" },
    select: { repositoryFullName: true, candidatePrNumber: true, candidateHeadSha: true, status: true },
  });
  for (const target of targets) {
    const run = rows.find(
      (row) =>
        row.repositoryFullName === target.repositoryFullName &&
        row.candidatePrNumber === target.number &&
        row.candidateHeadSha === target.headSha &&
        isReleaseCompletionActive(row.status),
    );
    if (run) result.set(`${target.repositoryFullName}#${target.number}`, { status: run.status, label: releaseCompletionStatusLabel(run.status) });
  }
  return result;
}
