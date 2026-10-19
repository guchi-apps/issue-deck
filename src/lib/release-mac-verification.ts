import { db } from "@/lib/db";
import { parseReleaseVerificationState, type ReleaseVerificationState } from "@/lib/release-merge-gate";
import type { ReleaseVerificationTarget } from "@/lib/release-verification";

/**
 * iOS検証（iOSのビルド確認）の独立した記録（#4366）。
 *
 * **ゲートの対象ではなく表示専用**。種別は`release-merge-gate.ts`の`RELEASE_VERIFICATION_KINDS`
 * （マージ判定・待ち判定・依頼時の行作成が全種別を回す）へ足さず、ここで別に持つ。保存先は同じ
 * `ReleaseVerification`表で、`kind`が文字列列なのでマイグレーションは要らない。
 * 統合検証の集約結果からMacの成功を推測せず、統合検証ジョブが報告したMacの結果だけを表示する。
 * 統合検証の記録（`integration`）側の挙動は変えない（Mac未接続の`needs_check`・Mac失敗の`failed`も従来どおり）。
 */
export const RELEASE_DISPLAY_ONLY_KINDS = ["mac"] as const;
export type ReleaseDisplayOnlyKind = (typeof RELEASE_DISPLAY_ONLY_KINDS)[number];

export const RELEASE_MAC_KIND: ReleaseDisplayOnlyKind = "mac";

export function parseReleaseDisplayOnlyKind(value: unknown): ReleaseDisplayOnlyKind | null {
  return typeof value === "string" && (RELEASE_DISPLAY_ONLY_KINDS as readonly string[]).includes(value)
    ? (value as ReleaseDisplayOnlyKind)
    : null;
}

export type ReleaseMacResult = {
  state: ReleaseVerificationState;
  summary?: string | null;
  /** 設定不足（スクリプト無し・Mac未接続）の理由。空でなければ成功と区別して「設定不足」にする */
  unverifiedScope?: string | null;
  evidenceUrl?: string | null;
  message?: string | null;
};

/** ジョブの報告本文の`mac`を読む。形が違えばnull（旧版のランナーは`mac`を送らない） */
export function parseReleaseMacReport(raw: unknown): ReleaseMacResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const state = parseReleaseVerificationState(body.state);
  if (!state || state === "waiting" || state === "not_run") return null;
  const str = (v: unknown, max: number) => (typeof v === "string" && v !== "" ? v.slice(0, max) : null);
  return {
    state,
    summary: str(body.summary, 20000),
    unverifiedScope: str(body.unverifiedScope, 5000),
    evidenceUrl: str(body.evidenceUrl, 500),
    message: str(body.message, 5000),
  };
}

/** Macの結果を、統合検証ジョブの対象（PR・base・head）へ記録する。行が無ければ作る（依頼時には作らないため） */
export async function recordReleaseMacResult(
  target: ReleaseVerificationTarget,
  result: ReleaseMacResult,
): Promise<void> {
  const where = { ...target, kind: RELEASE_MAC_KIND };
  const data = {
    state: result.state,
    summary: result.summary ?? null,
    unverifiedScope: result.unverifiedScope ?? null,
    evidenceUrl: result.evidenceUrl ?? null,
    message: result.message ?? null,
  };
  const updated = await db.releaseVerification.updateMany({ where, data });
  if (updated.count > 0) return;
  try {
    await db.releaseVerification.create({ data: { ...where, ...data } });
  } catch (error) {
    // 同時の報告は一意制約が止める。後から来た側が更新する
    if ((error as { code?: string }).code !== "P2002") throw error;
    await db.releaseVerification.updateMany({ where, data });
  }
}

export type ReleaseMacRow = {
  baseSha: string;
  headSha: string;
  state: ReleaseVerificationState;
  summary: string | null;
  unverifiedScope: string | null;
  evidenceUrl: string | null;
  message: string | null;
  updatedAt: Date;
};

export async function listReleaseMacRows(repoFullName: string, prNumber: number): Promise<ReleaseMacRow[]> {
  const rows = await db.releaseVerification.findMany({
    where: { repoFullName, prNumber, kind: RELEASE_MAC_KIND },
    orderBy: { updatedAt: "desc" },
  });
  return rows.flatMap((row) => {
    const state = parseReleaseVerificationState(row.state);
    if (!state) return [];
    return [
      {
        baseSha: row.baseSha,
        headSha: row.headSha,
        state,
        summary: row.summary,
        unverifiedScope: row.unverifiedScope,
        evidenceUrl: row.evidenceUrl,
        message: row.message,
        updatedAt: row.updatedAt,
      },
    ];
  });
}

/**
 * 画面に出すiOS検証の状態。`needs_setup`は「必要だが設定不足」で、成功や対象外へは置き換えない。
 * `not_recorded`は記録が無い（統合検証が先に失敗した・旧版のランナー・まだ動いていない）。
 */
export type ReleaseMacState =
  | "passed"
  | "failed"
  | "running"
  | "not_applicable"
  | "needs_setup"
  | "not_recorded"
  | "invalidated";

export type ReleaseMacSection = {
  state: ReleaseMacState;
  reason: string | null;
  summary: string | null;
  evidenceUrl: string | null;
  updatedAt: string | null;
};

/**
 * 現在の対象（base・head）に一致する記録だけを使う。対象が違う記録（作り直す前）は`invalidated`で、
 * 旧SHAの成功を見せない。記録が無いときに統合検証が動いている間は、動いている工程がMacなら「実行中」。
 */
export function describeReleaseMac(input: {
  current: { baseSha: string; headSha: string };
  rows: readonly ReleaseMacRow[];
  /** 現在の対象の統合検証ジョブが今Mac工程を実行しているか（進捗の記録から） */
  runningNow: boolean;
  /** このリポジトリがiOS検証を行う設定か（`macBuildCheck`）。未設定で記録も無ければ理由付き対象外 */
  configured?: boolean;
}): ReleaseMacSection {
  const { current, rows, runningNow } = input;
  const row = rows.find((r) => r.baseSha === current.baseSha && r.headSha === current.headSha);
  if (!row) {
    if (runningNow) {
      return { state: "running", reason: "iOSでのビルド確認を実行中です", summary: null, evidenceUrl: null, updatedAt: null };
    }
    if (rows.length > 0) {
      return {
        state: "invalidated",
        reason: "対象（mainの先端またはリリースブランチの先端）が変わったため、古い結果は使えません",
        summary: null,
        evidenceUrl: null,
        updatedAt: null,
      };
    }
    if (input.configured === false) {
      return {
        state: "not_applicable",
        reason: "このリポジトリにはiOS検証の設定がないため対象外です",
        summary: null,
        evidenceUrl: null,
        updatedAt: null,
      };
    }
    return { state: "not_recorded", reason: "iOS検証の記録がありません", summary: null, evidenceUrl: null, updatedAt: null };
  }
  const base = {
    summary: row.summary,
    evidenceUrl: row.evidenceUrl,
    updatedAt: row.updatedAt.toISOString(),
  };
  switch (row.state) {
    case "passed":
      return row.unverifiedScope
        ? { ...base, state: "needs_setup", reason: row.unverifiedScope }
        : { ...base, state: "passed", reason: null };
    case "needs_check":
      return { ...base, state: "needs_setup", reason: row.unverifiedScope ?? row.message ?? "設定が不足しています" };
    case "failed":
      return { ...base, state: "failed", reason: row.message ?? "iOS検証が失敗しました" };
    case "not_applicable":
      return { ...base, state: "not_applicable", reason: row.message ?? "ios/に差分がないため対象外です" };
    case "running":
    case "waiting":
      return { ...base, state: "running", reason: null };
    default:
      return { ...base, state: "not_recorded", reason: "iOS検証の記録がありません" };
  }
}
