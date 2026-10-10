import { db } from "@/lib/db";
import type { ReleaseVerificationDetailRow } from "@/lib/release-verification-summary";
import {
  RELEASE_VERIFICATION_KINDS,
  type ReleaseVerificationKind,
  type ReleaseVerificationRecord,
  type ReleaseVerificationState,
  parseReleaseVerificationKind,
  parseReleaseVerificationState,
} from "@/lib/release-merge-gate";

/**
 * 固定リリース（#4212）の検証記録の読み書き。判定そのものは`release-merge-gate.ts`の純粋関数。
 *
 * 対象キーはリポジトリ・PR番号・baseSha・headSha・種別。**SHAが変われば別の行になる**ので、
 * 作り直し・main更新のあとに古い行を書き換えて新しい対象へ流用することは起きない。
 */
export type ReleaseVerificationTarget = {
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
};

/** 依頼を受けたとき、種別ごとの行を`waiting`で作る（冪等。既にある行は触らない） */
export async function registerReleaseVerification(
  target: ReleaseVerificationTarget,
): Promise<{ created: ReleaseVerificationKind[] }> {
  const created: ReleaseVerificationKind[] = [];
  for (const kind of RELEASE_VERIFICATION_KINDS) {
    const where = { ...target, kind };
    const existing = await db.releaseVerification.findFirst({ where, select: { id: true } });
    if (existing) continue;
    try {
      await db.releaseVerification.create({ data: { ...where, state: "waiting" } });
      created.push(kind);
    } catch (error) {
      // 同じ対象への同時依頼は一意制約が止める。重複起動ではなく既存行を使う
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }
  return { created };
}

export type ReleaseVerificationResult = {
  kind: ReleaseVerificationKind;
  state: ReleaseVerificationState;
  agent?: string | null;
  summary?: string | null;
  findings?: unknown;
  unverifiedScope?: string | null;
  evidenceUrl?: string | null;
  message?: string | null;
};

/** 結果を記録する。**行の無い対象には書かない**（依頼を経ていない結果を受け付けない） */
export async function recordReleaseVerificationResult(
  target: ReleaseVerificationTarget,
  result: ReleaseVerificationResult,
): Promise<boolean> {
  const { kind, findings, ...rest } = result;
  const updated = await db.releaseVerification.updateMany({
    where: { ...target, kind },
    data: { ...rest, ...(findings === undefined ? {} : { findings: findings as object }) },
  });
  return updated.count > 0;
}

/** PRの検証記録を、SHAを問わず全部返す（古い行は`viewReleaseVerifications`が無効にする） */
export async function listReleaseVerificationRecords(
  repoFullName: string,
  prNumber: number,
): Promise<ReleaseVerificationRecord[]> {
  const rows = await db.releaseVerification.findMany({
    where: { repoFullName, prNumber },
    orderBy: { updatedAt: "desc" },
  });
  return rows.flatMap((row) => {
    const kind = parseReleaseVerificationKind(row.kind);
    const state = parseReleaseVerificationState(row.state);
    if (!kind || !state) return [];
    return [{ kind, state, baseSha: row.baseSha, headSha: row.headSha, unverifiedScope: row.unverifiedScope }];
  });
}

/** 画面向けに、要約・指摘・担当を含む行を返す（#4238）。古いSHAの行も含め、判定側が無効にする */
export async function listReleaseVerificationDetails(
  repoFullName: string,
  prNumber: number,
): Promise<ReleaseVerificationDetailRow[]> {
  const rows = await db.releaseVerification.findMany({
    where: { repoFullName, prNumber },
    orderBy: { updatedAt: "desc" },
  });
  return rows.flatMap((row) => {
    const kind = parseReleaseVerificationKind(row.kind);
    const state = parseReleaseVerificationState(row.state);
    if (!kind || !state) return [];
    return [
      {
        kind,
        state,
        baseSha: row.baseSha,
        headSha: row.headSha,
        agent: row.agent,
        summary: row.summary,
        findings: row.findings,
        unverifiedScope: row.unverifiedScope,
        evidenceUrl: row.evidenceUrl,
        message: row.message,
        updatedAt: row.updatedAt,
      },
    ];
  });
}
