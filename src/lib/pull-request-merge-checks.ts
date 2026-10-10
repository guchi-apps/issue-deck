import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";
import type { CiState } from "@/lib/github/release-api";
import type { ReleaseChangePullRequest } from "@/types/pull-request";

/**
 * 本番マージ確認ダイアログのPR一覧に出す5チェック（#4305）の表示内容を決める。
 *
 * 5項目は**独立した状態**で、1つの「レビュー」や総合成功へまとめない。実際に取得できた状態だけを
 * 出し、情報が足りないものを成功と推測しない（記録なし・取得不可・未実施を別の状態にする）。
 * 並びは固定: CI → 計画 → コード → 全体〔共通〕 → 競合。
 */
export type MergeCheckKey = "ci" | "plan" | "code" | "all" | "conflict";

export const MERGE_CHECK_KEYS: readonly MergeCheckKey[] = ["ci", "plan", "code", "all", "conflict"];

export type MergeCheckTone = "ok" | "bad" | "warn" | "run" | "muted";

/** 詳細から辿る証跡。`pr`はPR詳細、`issue`は関連Issue、`overall`は同じ画面の全体レビュー（共通詳細） */
export type MergeCheckEvidence = { kind: "pr" | "issue" | "overall"; label: string };

export type MergeCheckItem = {
  key: MergeCheckKey;
  /** 行に出す短い名前 */
  shortLabel: string;
  /** 詳細に出す正式名称 */
  fullName: string;
  /** 色に頼らず状態を示す記号 */
  mark: string;
  /** 状態の短い日本語 */
  state: string;
  tone: MergeCheckTone;
  /** 何を対象にした判定か */
  target: string;
  /** 理由・指摘。無ければnull */
  reason: string | null;
  evidence: MergeCheckEvidence | null;
  /** リリース全体の共通結果か（全体レビュー・競合） */
  common: boolean;
};

/** 全体レビュー・競合のようにリリース共通の値。行ごとには計算せず、同じ値を全行へ渡す */
export type SharedMergeCheck = Pick<MergeCheckItem, "mark" | "state" | "tone" | "reason">;

export type MergeChecksInput = {
  /** 一覧に対応する個別PR。見つからなければnull（追加取得前・一覧に出ていない行） */
  pullRequest: ReleaseChangePullRequest | null;
  /** 全体レビュー（`describeSection`と同じ判定）。取得中・取得不可でも渡す */
  overall: SharedMergeCheck;
  /** リリース候補の競合（`MergePrecheckRow`から）。個別PRの過去の結果と混ぜない */
  conflict: SharedMergeCheck;
  /** リリース候補のCI。個別PRのCIの詳細に併記する（同じ表示にはしない） */
  releaseCi: CiState;
  releaseHeadRef: string;
};

const RELEASE_CI_LABEL: Record<CiState, string> = {
  success: "成功",
  pending: "実行中",
  failure: "失敗",
  unknown: "不明",
};

function ciItem(input: MergeChecksInput): MergeCheckItem {
  const base = {
    key: "ci" as const,
    shortLabel: "CI",
    fullName: "CI（個別PRのチェック）",
    common: false,
    evidence: { kind: "pr", label: "PRのChecksを開く" } as MergeCheckEvidence,
  };
  const releaseNote = `リリース候補 ${input.releaseHeadRef} のCIは${RELEASE_CI_LABEL[input.releaseCi]}（別の判定）`;
  const target = "このPRのheadコミットの、マージ時点までの結果（個別PRの過去の結果）";
  const checks = input.pullRequest?.mergeChecks;
  if (!checks) {
    return { ...base, mark: "？", state: "取得不可", tone: "warn", target, reason: `CIを取得できませんでした。成功とは扱いません。${releaseNote}` };
  }
  switch (checks.ci.state) {
    case "success":
      return { ...base, mark: "●", state: "成功", tone: "ok", target, reason: releaseNote };
    case "pending":
      return { ...base, mark: "◷", state: "実行中", tone: "run", target, reason: releaseNote };
    case "failure":
      return { ...base, mark: "■", state: "失敗", tone: "bad", target, reason: `個別PRのCIが失敗しています。${releaseNote}` };
    case "none":
      return { ...base, mark: "○", state: "記録なし", tone: "muted", target, reason: `このPRのheadにチェックの記録がありません。${releaseNote}` };
    default:
      return { ...base, mark: "？", state: "取得不可", tone: "warn", target, reason: `CIを取得できませんでした。成功とは扱いません。${releaseNote}` };
  }
}

function planItem(input: MergeChecksInput): MergeCheckItem {
  const base = {
    key: "plan" as const,
    shortLabel: "計画",
    fullName: "計画レビュー（関連Issueの計画）",
    common: false,
  };
  const issueNumber = input.pullRequest?.issueNumber ?? null;
  const evidence: MergeCheckEvidence | null =
    issueNumber !== null ? { kind: "issue", label: `Issue #${issueNumber}の計画を開く` } : null;
  const target = issueNumber !== null ? `関連Issue #${issueNumber}の計画コメントとレビュー` : "関連Issue（特定できません）";
  const plan = input.pullRequest?.mergeChecks?.plan;
  if (!plan) {
    return { ...base, mark: "？", state: "取得不可", tone: "warn", target, reason: "計画の記録を取得できませんでした", evidence };
  }
  const reason = plan.reason;
  switch (plan.state) {
    case "reviewed":
      return { ...base, mark: "●", state: "問題なし", tone: "ok", target, reason, evidence };
    case "findings":
      return { ...base, mark: "■", state: "要修正", tone: "bad", target, reason, evidence };
    case "unresolved":
    case "limit":
      return { ...base, mark: "▲", state: "要確認", tone: "warn", target, reason, evidence };
    case "skipped":
      return { ...base, mark: "⊘", state: "省略", tone: "muted", target, reason, evidence };
    case "unreviewed":
      return { ...base, mark: "–", state: "未実施", tone: "muted", target, reason, evidence };
    case "no-plan":
      return { ...base, mark: "⊘", state: "対象外", tone: "muted", target, reason: reason ?? "計画の記録がありません", evidence };
    case "not-applicable":
      return { ...base, mark: "⊘", state: "対象外", tone: "muted", target, reason, evidence: null };
    default:
      return { ...base, mark: "？", state: "取得不可", tone: "warn", target, reason: reason ?? "計画の記録を取得できませんでした", evidence };
  }
}

function codeItem(input: MergeChecksInput): MergeCheckItem {
  const base = {
    key: "code" as const,
    shortLabel: "コード",
    fullName: "コードレビュー（このPRのAIレビュー）",
    common: false,
    evidence: { kind: "pr", label: "PR詳細を開く" } as MergeCheckEvidence,
  };
  const pr = input.pullRequest;
  const target = "このPRのAIレビュー（PR本文の検証結果）";
  if (!pr || pr.reviewUnavailable) {
    return { ...base, mark: "？", state: "取得不可", tone: "warn", target, reason: "PR本文を取得できませんでした。問題なしとは扱いません" };
  }
  const review = pr.review;
  if (!review) {
    return { ...base, mark: "○", state: "記録なし", tone: "muted", target, reason: "判定の記録がありません" };
  }
  const freshness = resolveReviewVerdictFreshness({ reviewedSha: review.reviewedSha, headSha: pr.prHeadSha });
  if (freshness === "stale") {
    return {
      ...base,
      mark: "⟳",
      state: "無効",
      tone: "warn",
      target,
      reason: "判定の後にPRのheadが変わったため、今の内容に対する判定ではありません",
    };
  }
  const reason = review.reviewLabel;
  switch (review.reviewKind) {
    case "ok":
      return { ...base, mark: "●", state: "問題なし", tone: "ok", target, reason };
    case "needs-check":
      return { ...base, mark: "▲", state: "要確認", tone: "warn", target, reason };
    case "changes-requested":
      return { ...base, mark: "■", state: "要修正", tone: "bad", target, reason };
    case "skipped":
      return { ...base, mark: "⊘", state: "省略", tone: "muted", target, reason: "低リスクのためレビューを省略（意図的な省略）" };
    default:
      return { ...base, mark: "○", state: "記録なし", tone: "muted", target, reason: "判定の記録がありません" };
  }
}

/** 5項目を、固定の並びで返す */
export function buildMergeChecks(input: MergeChecksInput): MergeCheckItem[] {
  return [
    ciItem(input),
    planItem(input),
    codeItem(input),
    {
      key: "all",
      shortLabel: "全体〔共通〕",
      fullName: "全体レビュー（リリース全体の共通結果）",
      target: "リリース候補全体の差分。すべてのPR行で同じ結果を使います",
      evidence: { kind: "overall", label: "全体レビューの詳細へ" },
      common: true,
      ...input.overall,
    },
    {
      key: "conflict",
      shortLabel: "競合",
      fullName: "コンフリクト（リリース候補）",
      target: `リリース候補 ${input.releaseHeadRef} をmainへ統合した結果。個別PRの過去の結果ではありません`,
      evidence: null,
      common: true,
      ...input.conflict,
    },
  ];
}
