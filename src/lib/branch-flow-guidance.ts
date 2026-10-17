import type { BranchFlowRepository } from "@/types/branch-flow";
import type { ReleaseCandidateVerification } from "@/lib/release-candidate-status";

export type BranchFlowGuidance = { state: string; next: string; attention: boolean };

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
  const result = (state: string, next: string, attention = false) => ({ state, next, attention });
  // 既知の失敗を、同時に走っている処理で覆わない。
  if (summary.deploy?.kind === "failure") {
    return result("デプロイ失敗", "復旧方法を確認", true);
  }
  if (options.branchesFailed || !repository.branchesLoaded) {
    return result("状態未取得", "取得状況を確認", true);
  }
  if (options.verification?.problem) {
    return result(options.verification.problem.label, "必要な対応を確認", true);
  }
  if (summary.pullRequestHealth.humanCount > 0) {
    return result("対応が必要", "問題のPRを確認", true);
  }
  if (summary.releaseMergeTarget) {
    return result("操作待ち", "公開手順を確認", true);
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
