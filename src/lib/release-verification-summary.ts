import {
  evaluateReleaseMergeGate,
  viewReleaseVerifications,
  type ReleaseMergeGate,
  type ReleaseMergeGateBlocker,
  type ReleaseVerificationKind,
  type ReleaseVerificationState,
} from "@/lib/release-merge-gate";
import {
  describeReleaseMac,
  type ReleaseMacRow,
  type ReleaseMacSection,
} from "@/lib/release-mac-verification";
import { readReleaseReviewDiagnostic, type ReleaseReviewDiagnostic } from "@/lib/release-review-diagnostic";
import type { ReleaseReviewDecisionSummary } from "@/lib/release-review-decision";
import type { ReleaseReviewCoverage, ReleaseReviewFinding, ReleaseReviewMeta } from "@/lib/release-review-result";
import type { ReleaseVerificationProgress } from "@/lib/release-verification-progress";
import {
  describeReviewEvidenceStage,
  readAutoReevaluation,
  type ReviewAutoReevaluation,
  type ReviewEvidenceStage,
} from "@/lib/release-review-reevaluation";

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
  /** リリースを止める指摘（旧形式の指摘もここ） */
  findings: ReleaseReviewFinding[];
  /** リリースを止めない改善提案（#4559） */
  suggestions: ReleaseReviewFinding[];
  /** 確認契約の記録（確認項目の版・初回／再レビュー・項目別の結果・前回指摘の解消）。無ければnull */
  review: ReleaseReviewMeta | null;
  affectedPullRequests: number[];
  affectedFiles: string[];
  reviewedFiles: number | null;
  totalFiles: number | null;
  /** ファイル別の確認実績。旧結果ではnull（実績不明） */
  coverage: ReleaseReviewCoverage | null;
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
  /** 再実行で置き換わる前の直前の結果（#4632）。現在の結果ではなく履歴。無ければnull */
  previousRun: ReleaseVerificationPreviousRun | null;
  /**
   * 指摘ごとのユーザー判断（#4657。全体レビューだけ）。AIの原判定（`findings`・`state`）とは別に持ち、
   * 判断で`state`を書き換えない。読み出していない・読めなかったときはnull
   */
  decisions?: ReleaseReviewDecisionSummary | null;
  /** 記録された未確認範囲そのもの（判断で解除してよいかの判定に使う）。無ければnull */
  unverifiedScope?: string | null;
  /** 自動再評価の印（#4664。全体レビューだけ）。無ければnull */
  autoReevaluation?: ReviewAutoReevaluation | null;
  /**
   * 統合検証の証跡から見た全体レビューの共通の段階（#4664。全体レビューだけ）。バッジ・説明・詳細・本番確認が
   * 同じ値を出す。統合検証の区分では省略
   */
  stage?: ReviewEvidenceStage;
};

export type ReleaseVerificationPreviousRun = {
  state: string;
  at: string;
  unverifiedScope: string | null;
  summary: string | null;
};

export type ReleaseVerificationSummary = {
  /** マージAPIが検証結果を必須にしているか。falseの間は表示のみで、マージは止まらない */
  enforced: boolean;
  /** 強制の有無にかかわらず、現在の記録で判定した結果 */
  gateStatus: ReleaseMergeGate["status"] | "not_enforced";
  blockers: ReleaseMergeGateBlocker[];
  integration: ReleaseVerificationSection;
  aiReview: ReleaseVerificationSection;
  /** Mac検証（#4366）。統合検証とは別の記録で、ゲートの判定には使わない */
  mac: ReleaseMacSection;
  /** 全体レビューを今積んだ場合の実効担当（表示用。例: `Claude Code · opus`） */
  aiReviewAssignee: string;
  /** 判定の対象（GitHubから取った現在のbase・head）。画面は「どのSHAの結果か」を出すのに使う */
  target: { baseSha: string; headSha: string };
};

function readPreviousRun(findings: unknown): ReleaseVerificationPreviousRun | null {
  const raw = typeof findings === "object" && findings !== null ? (findings as Record<string, unknown>).previousRun : null;
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== "string" || typeof r.at !== "string") return null;
  return {
    state: r.state,
    at: r.at,
    unverifiedScope: typeof r.unverifiedScope === "string" ? r.unverifiedScope : null,
    summary: typeof r.summary === "string" ? r.summary : null,
  };
}

function readDetail(findings: unknown) {
  const raw = (typeof findings === "object" && findings !== null ? findings : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  return {
    findings: list(raw.findings).filter((f): f is ReleaseReviewFinding => typeof f === "object" && f !== null),
    suggestions: list(raw.suggestions).filter((f): f is ReleaseReviewFinding => typeof f === "object" && f !== null),
    review:
      typeof raw.review === "object" && raw.review !== null && !Array.isArray(raw.review)
        ? (raw.review as ReleaseReviewMeta)
        : null,
    affectedPullRequests: list(raw.affectedPullRequests).filter((n): n is number => typeof n === "number"),
    affectedFiles: list(raw.affectedFiles).filter((f): f is string => typeof f === "string"),
    reviewedFiles: int(raw.reviewedFiles),
    totalFiles: int(raw.totalFiles),
    coverage:
      typeof raw.coverage === "object" && raw.coverage !== null && !Array.isArray(raw.coverage)
        ? (raw.coverage as ReleaseReviewCoverage)
        : null,
  };
}

/** 現在の対象の統合検証ジョブが、今Mac工程を実行しているか */
function isRunningMacStep(progress: ReleaseVerificationProgress | null): boolean {
  if (!progress || progress.jobStatus !== "running" || progress.currentIndex === null) return false;
  return progress.steps[progress.currentIndex]?.key === "mac";
}

/** 要約の2区分から全体レビューの共通の段階を出す（#4664）。画面側で要約を組み直したときにも使う */
export function reviewStageOf(
  aiReview: ReleaseVerificationSection,
  integration: Pick<ReleaseVerificationSection, "state" | "updatedAt">,
): ReviewEvidenceStage {
  return describeReviewEvidenceStage(
    {
      state: aiReview.state,
      updatedAt: aiReview.updatedAt,
      findingsCount: aiReview.findings.length,
      checks: aiReview.review?.checks ?? null,
      openFiles: aiReview.coverage?.open.length ?? 0,
      unverifiedScope: aiReview.unverifiedScope ?? null,
      reason: aiReview.reason,
      summary: aiReview.summary,
      autoReevaluation: aiReview.autoReevaluation ?? null,
      executionFailed: aiReview.diagnostic !== null,
    },
    { state: integration.state, updatedAt: integration.updatedAt },
  );
}

export function summarizeReleaseVerification(input: {
  current: { baseSha: string; headSha: string };
  rows: readonly ReleaseVerificationDetailRow[];
  enforced: boolean;
  aiReviewAssignee: string;
  /** 区分ごとの進捗（`loadReleaseVerificationSummary`が現在の対象のジョブから作る） */
  progress?: Partial<Record<ReleaseVerificationKind, ReleaseVerificationProgress | null>>;
  /** Mac検証の記録（表示専用。無ければ空） */
  macRows?: readonly ReleaseMacRow[];
  /** このリポジトリがMac検証を行う設定か。省略時は設定ありとして扱う */
  macConfigured?: boolean;
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
      previousRun: readPreviousRun(row?.findings),
      decisions: null,
      unverifiedScope: row?.unverifiedScope ?? null,
      autoReevaluation: kind === "ai_review" ? readAutoReevaluation(row?.findings) : null,
    };
  };

  const integration = section("integration");
  const aiReview = section("ai_review");
  aiReview.stage = reviewStageOf(aiReview, integration);

  return {
    enforced: input.enforced,
    gateStatus: gate.status,
    blockers: gate.blockers,
    integration,
    aiReview,
    mac: describeReleaseMac({
      current,
      rows: input.macRows ?? [],
      runningNow: isRunningMacStep(input.progress?.integration ?? null),
      configured: input.macConfigured,
    }),
    aiReviewAssignee: input.aiReviewAssignee,
    target: { baseSha: current.baseSha, headSha: current.headSha },
  };
}
