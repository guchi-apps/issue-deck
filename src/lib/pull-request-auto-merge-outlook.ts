import { deriveMergeHold } from "@/lib/pull-request-merge-hold";
import { isSystemBranch } from "@/lib/system-branch";
import type { PullRequestSummary } from "@/types/pull-request";

export { SYSTEM_BRANCH_PREFIXES, isSystemBranch } from "@/lib/system-branch";

/**
 * - `scheduled` … GitHubのAuto-mergeが予約済み。必須チェックが通れば自動でマージされる
 * - `expected` … 判定・CIの途中。止める理由が出なければ予約される見込み
 * - `manual` … 自動マージされない。人がマージする
 * - `excluded` … 専用の経路（リリース・タグ配布など）がマージするPR
 */
export type AutoMergeOutlookKind = "scheduled" | "expected" | "manual" | "excluded";

export type AutoMergeOutlook = {
  kind: AutoMergeOutlookKind;
  /** 帯の見出し（「予約済み」など） */
  label: string;
  /** 理由と、次に何が起きるか・何をするか */
  reason: string;
};

const LABEL: Record<AutoMergeOutlookKind, string> = {
  scheduled: "予約済み",
  expected: "予定",
  manual: "されません",
  excluded: "対象外",
};

function outlook(kind: AutoMergeOutlookKind, reason: string): AutoMergeOutlook {
  return { kind, label: LABEL[kind], reason };
}

/**
 * マージ待ちのPRが自動マージされるかを、一覧・詳細が既に持っている値から導く（#4952）。
 *
 * **判定を再実装しない。** 結論は`claude-review-develop.yml`がGitHubのAuto-merge（`autoMergeEnabled`）と
 * 対応Issue・PRの`00.check-user`に書くので、それと判定ジョブの進み具合・失敗だけを読む。判定が終わったのに
 * 予約されていないPRは、理由が読めなくても「されません」と言い切る（「止める理由はありません」で放置させない）。
 * 開いていない・draftのPR、develop以外へ向かうPR（リリースPRを除く）はnull。
 */
export function deriveAutoMergeOutlook(pullRequest: PullRequestSummary): AutoMergeOutlook | null {
  if (pullRequest.state !== "open" || pullRequest.merged || pullRequest.draft) return null;
  if (pullRequest.kind === "release") {
    return outlook("manual", "develop→mainのリリースPRは、人がマージします");
  }
  if (pullRequest.baseRef !== "develop") return null;
  if (pullRequest.autoMergeEnabled) {
    return outlook("scheduled", "必須チェックが通るとdevelopへ自動でマージされます（操作は不要です）");
  }
  if (pullRequest.kind === "version-bump" || isSystemBranch(pullRequest.headRef)) {
    return outlook("excluded", "リリース・配布用のPRです。リリースの流れの中で専用の経路がマージします");
  }

  const failed = pullRequest.mergeJudgement.failedJobs ?? [];
  if (failed.includes("review-provider")) {
    return outlook("manual", "レビュー担当を決めるジョブが失敗し、レビューと自動マージが止まっています。判定ログからジョブを再実行できます");
  }
  if (failed.includes("claude-review") || failed.includes("codex-review")) {
    return outlook("manual", "自動レビューが失敗したため、自動マージされません。内容を確認してマージします");
  }
  if (failed.includes("auto-merge")) {
    return outlook("manual", "自動マージの予約に失敗しました。判定ログを確認し、内容を確かめてマージします");
  }

  // 開いた直後は判定のcheck-runがまだ無い。CIが走っている間は、判定が始まる前として扱う
  if (pullRequest.mergeJudgement.state === "unknown" && pullRequest.ciState === "pending") {
    return outlook("expected", "CIと自動マージの判定が終わり、止める理由が出なければ自動マージを予約します");
  }
  const hold = deriveMergeHold(pullRequest);
  if (hold.status === "held") {
    return outlook("manual", hold.reasons.map((reason) => reason.text).join(" / "));
  }
  if (pullRequest.mergeJudgement.state === "pending") {
    return outlook("expected", "判定で止める理由が出なければ、自動マージを予約します");
  }
  if (pullRequest.mergeJudgement.state === "unknown") {
    return outlook("manual", "自動マージの判定の記録が見つかりません。判定が動いていないため、内容を確認してマージします");
  }
  return outlook("manual", "判定は終わりましたが、自動マージは予約されませんでした。判定ログで理由を確認できます");
}
