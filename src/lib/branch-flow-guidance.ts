import type { BranchFlowRepository } from "@/types/branch-flow";
import type { ReleaseCandidateVerification } from "@/lib/release-candidate-status";

/**
 * 手が要るときの内訳（#5099）。`approval`＝公開・マージを進めてよいかの承認、`decision`＝要確認など問題の扱いの判断、
 * `problem`＝失敗・問題による停止（赤）、`other`＝取得失敗・残作業など。導線の見た目にだけ使い、`attention`の判定は変えない
 */
export type BranchFlowGuidanceKind = "approval" | "decision" | "problem" | "other";

export type BranchFlowGuidance = { state: string; next: string; attention: boolean; kind: BranchFlowGuidanceKind; loading?: boolean };

/** 赤のPR健全性カテゴリ（`pull-request-health-chips.tsx`の`bad`）。`failingHumanCount`が無い古い集計の代わりに見る */
const FAILING_CATEGORIES = ["ci-failed", "review-changes-requested", "conflict", "review-failed", "repair-stopped"] as const;

/** 表示専用。承認・マージ可否は既存のサーバー側判定を使う。 */
export function describeBranchFlow(
  repository: BranchFlowRepository,
  options: {
    branchesFailed: boolean;
    releaseLaunching: boolean;
    verification: ReleaseCandidateVerification | null;
    unreleasedCount: number;
  },
): BranchFlowGuidance {
  const { summary } = repository;
  const result = (state: string, next: string, attention = false, kind: BranchFlowGuidanceKind = "other"): BranchFlowGuidance => ({
    state,
    next,
    attention,
    kind,
  });
  // 既知の失敗を、同時に走っている処理で覆わない。
  if (summary.deploy?.kind === "failure") {
    return result("デプロイ失敗", "復旧方法を確認", true, "problem");
  }
  if (options.branchesFailed) {
    return result("状態未取得", "取得状況を確認", true);
  }
  // まだ取得できていないだけで、失敗ではない。警告色にせず取得中として見せる（#4788）
  if (!repository.branchesLoaded) {
    return { ...result("状態未取得", "取得状況を確認"), loading: true };
  }
  if (options.verification?.problem) {
    const { kind } = options.verification.problem;
    return result(
      options.verification.problem.label,
      "必要な対応を確認",
      true,
      kind === "needs_check" ? "decision" : kind === "unavailable" ? "other" : "problem",
    );
  }
  if (summary.pullRequestHealth.humanCount > 0) {
    const health = summary.pullRequestHealth;
    const failing = health.failingHumanCount ?? FAILING_CATEGORIES.reduce((sum, category) => sum + health.counts[category], 0);
    return result("対応が必要", "問題のPRを確認", true, failing > 0 ? "problem" : "decision");
  }
  if (summary.releaseMergeTarget) {
    return result("操作待ち", "公開手順を確認", true, "approval");
  }
  if (summary.deploy?.kind === "running" || summary.deploy?.kind === "waiting") {
    return result("本番反映中", "進捗を見る");
  }
  if (options.verification?.progress) {
    return result(options.verification.progress.label, "進捗を見る");
  }
  if (options.releaseLaunching || summary.releaseInProgress) {
    return result("リリース処理中", "進捗を見る");
  }
  if (summary.openManualStepCount > 0 || repository.orphanIssues.length > 0) {
    return result("残作業あり", "残作業を確認", true);
  }
  if (options.unreleasedCount > 0) {
    return result("未リリース", repository.deviceBuild
      ? "実機反映の手順"
      : "公開する変更を見る");
  }
  if (summary.activeLaneCount > 0 || summary.startedIssueCount > 0) {
    return result("開発中", "作業・PRを見る");
  }
  if (!repository.release.comparison) return result("変更を未確認", "取得状況を確認");
  return result("公開前の変更なし", "詳細を見る");
}
