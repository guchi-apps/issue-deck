import {
  evaluateReleaseMergeGate,
  viewReleaseVerifications,
  type ReleaseMergeGate,
  type ReleaseMergeGateBlocker,
  type ReleaseVerificationKind,
  type ReleaseVerificationState,
} from "@/lib/release-merge-gate";
import { readReleaseReviewDiagnostic, type ReleaseReviewDiagnostic } from "@/lib/release-review-diagnostic";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";
import type { ReleaseVerificationProgress } from "@/lib/release-verification-progress";

/**
 * リリース画面の「統合検証」「全体レビュー」2区分（#4238）の表示用の要約。画面（`GET /api/repositories/release`）が
 * 返す形で、**判定は`release-merge-gate.ts`の純関数に委ねる**（画面とマージAPIで食い違わせない）。
 * 個別PRレビューの区分は既存の「今回反映する内容」（`useReleaseChanges`）が持つので、ここには含めない。
 */
export type ReleaseVerificationDetailRow = {
  kind: ReleaseVerificationKind;
  state: ReleaseVerificationState;
  baseSha: string;
  headSha: string;
  agent: string | null;
  summary: string | null;
  findings: unknown;
  unverifiedScope: string | null;
  evidenceUrl: string | null;
  message: string | null;
  updatedAt: Date;
};

export type ReleaseVerificationSection = {
  kind: ReleaseVerificationKind;
  state: ReleaseVerificationState | "invalidated";
  /** 状態の理由（未確認範囲・対象変更による無効・失敗の理由）。無ければnull */
  reason: string | null;
  summary: string | null;
  evidenceUrl: string | null;
  /** 全体レビューの担当AI（`claude:opus`など）。統合検証ではnull */
  agent: string | null;
  updatedAt: string | null;
  findings: ReleaseReviewFinding[];
  affectedPullRequests: number[];
  affectedFiles: string[];
  reviewedFiles: number | null;
  totalFiles: number | null;
  /**
   * 現在の対象（base・head）を実行している、または最後に実行したジョブの進捗（#4277）。
   * 対象の違うジョブは渡さない（古い実行の工程を現在の進捗に見せない）。ジョブが無ければnull
   */
  progress: ReleaseVerificationProgress | null;
  /**
   * 全体レビューが実行失敗したときの診断（#4300）。**現在の対象（base・head）に対応するものだけ**。
   * コードへの指摘（`findings`）とは別で、`state`が`failed`のときだけ入る
   */
  diagnostic: ReleaseReviewDiagnostic | null;
};

export type ReleaseVerificationSummary = {
  /** マージAPIが検証結果を必須にしているか。falseの間は表示のみで、マージは止まらない */
  enforced: boolean;
  /** 強制の有無にかかわらず、現在の記録で判定した結果 */
  gateStatus: ReleaseMergeGate["status"] | "not_enforced";
  blockers: ReleaseMergeGateBlocker[];
  integration: ReleaseVerificationSection;
  aiReview: ReleaseVerificationSection;
  /** 全体レビューを今積んだ場合の実効担当（表示用。例: `Claude Code · opus`） */
  aiReviewAssignee: string;
  /** 判定の対象（GitHubから取った現在のbase・head）。画面は「どのSHAの結果か」を出すのに使う */
  target: { baseSha: string; headSha: string };
};

function readDetail(findings: unknown) {
  const raw = (typeof findings === "object" && findings !== null ? findings : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  return {
    findings: list(raw.findings).filter((f): f is ReleaseReviewFinding => typeof f === "object" && f !== null),
    affectedPullRequests: list(raw.affectedPullRequests).filter((n): n is number => typeof n === "number"),
    affectedFiles: list(raw.affectedFiles).filter((f): f is string => typeof f === "string"),
    reviewedFiles: int(raw.reviewedFiles),
    totalFiles: int(raw.totalFiles),
  };
}

export function summarizeReleaseVerification(input: {
  current: { baseSha: string; headSha: string };
  rows: readonly ReleaseVerificationDetailRow[];
  enforced: boolean;
  aiReviewAssignee: string;
  /** 区分ごとの進捗（`loadReleaseVerificationSummary`が現在の対象のジョブから作る） */
  progress?: Partial<Record<ReleaseVerificationKind, ReleaseVerificationProgress | null>>;
}): ReleaseVerificationSummary {
  const { current, rows } = input;
  const views = viewReleaseVerifications(current, rows);
  const gate = evaluateReleaseMergeGate({ current, records: rows, enforced: true });

  const section = (kind: ReleaseVerificationKind): ReleaseVerificationSection => {
    const view = views.find((v) => v.kind === kind);
    const row = rows
      .filter((r) => r.kind === kind && r.baseSha === current.baseSha && r.headSha === current.headSha)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    const detail = readDetail(row?.findings);
    const progress = input.progress?.[kind] ?? null;
    // 記録は結果が届くまで`waiting`のまま。実行側が動き出していれば、表示だけ「実行中」にする
    // （ゲートの判定は記録で行うので、ここで変えても通る条件は変わらない）
    const recorded = view?.state ?? "not_run";
    const state = recorded === "waiting" && progress?.jobStatus === "running" ? "running" : recorded;
    const reason =
      view?.reason ??
      (row?.unverifiedScope ? `未確認範囲があります: ${row.unverifiedScope}` : null) ??
      null;
    return {
      kind,
      state,
      reason: reason ?? (state === "failed" || state === "not_applicable" ? (row?.message ?? null) : null),
      summary: row?.summary ?? null,
      evidenceUrl: row?.evidenceUrl ?? null,
      agent: row?.agent ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      ...detail,
      progress,
      diagnostic: state === "failed" ? readReleaseReviewDiagnostic(row?.findings, current) : null,
    };
  };

  return {
    enforced: input.enforced,
    gateStatus: gate.status,
    blockers: gate.blockers,
    integration: section("integration"),
    aiReview: section("ai_review"),
    aiReviewAssignee: input.aiReviewAssignee,
    target: { baseSha: current.baseSha, headSha: current.headSha },
  };
}
