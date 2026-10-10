import type { ReleaseVerificationState } from "@/lib/release-merge-gate";

/**
 * リリース全体のAIレビュー（#4238）の結果の正規化。ランナーが報告した生の値を、記録できる形へ絞る。
 *
 * **AIのLGTMだけで「準備完了」にしない。** 指摘が1件でもある場合は`needs_check`、確認できなかった範囲が
 * ある場合は未確認範囲つきの`passed`（判定側が理由付きの`needs_check`へ読み替える）にし、どちらも
 * 既存の明示確認フローへ渡る。`failed`は
 * レビューを完走できなかったときだけ。
 */
export type ReleaseReviewFinding = {
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  file: string | null;
  /** 影響するPR番号 */
  pullRequests: number[];
};

export type ReleaseReviewDetail = {
  findings: ReleaseReviewFinding[];
  affectedPullRequests: number[];
  affectedFiles: string[];
  reviewedFiles: number | null;
  totalFiles: number | null;
};

export type NormalizedReleaseReview = {
  state: Extract<ReleaseVerificationState, "passed" | "needs_check" | "failed">;
  summary: string | null;
  detail: ReleaseReviewDetail;
  unverifiedScope: string | null;
};

const MAX_FINDINGS = 50;

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function prNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const numbers = value.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
  return [...new Set(numbers)].slice(0, 100);
}

function normalizeFinding(value: unknown): ReleaseReviewFinding | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const title = str(raw.title, 200);
  if (!title) return null;
  const severity = raw.severity === "high" || raw.severity === "low" ? raw.severity : "medium";
  return {
    severity,
    title,
    detail: str(raw.detail, 2000) ?? "",
    file: str(raw.file, 300),
    pullRequests: prNumbers(raw.pullRequests),
  };
}

export function normalizeReleaseReview(body: unknown): NormalizedReleaseReview | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (raw.state !== "passed" && raw.state !== "needs_check" && raw.state !== "failed") return null;

  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .map(normalizeFinding)
    .filter((f): f is ReleaseReviewFinding => f !== null)
    .slice(0, MAX_FINDINGS);
  const reviewedFiles = nonNegativeInt(raw.reviewedFiles);
  const totalFiles = nonNegativeInt(raw.totalFiles);
  const affectedFiles = (Array.isArray(raw.affectedFiles) ? raw.affectedFiles : [])
    .map((f) => str(f, 300))
    .filter((f): f is string => f !== null)
    .slice(0, 200);

  const unverified: string[] = [];
  const reported = str(raw.unverifiedScope, 2000);
  if (reported) unverified.push(reported);
  if (reviewedFiles !== null && totalFiles !== null && reviewedFiles < totalFiles) {
    unverified.push(`差分${totalFiles}ファイルのうち${reviewedFiles}ファイルしか確認できていません`);
  }
  const unverifiedScope = unverified.length > 0 ? [...new Set(unverified)].join(" / ") : null;

  // 未確認範囲だけの場合は`passed`のまま持つ。`viewReleaseVerifications`が未確認範囲つきの
  // `passed`を理由付きの`needs_check`へ読み替えるので、ゲートの理由に範囲が出る
  const state = raw.state === "failed" ? "failed" : findings.length > 0 ? "needs_check" : "passed";
  return {
    state,
    summary: str(raw.summary, 20000),
    detail: {
      findings,
      affectedPullRequests: [...new Set([...prNumbers(raw.affectedPullRequests), ...findings.flatMap((f) => f.pullRequests)])],
      affectedFiles,
      reviewedFiles,
      totalFiles,
    },
    unverifiedScope,
  };
}
