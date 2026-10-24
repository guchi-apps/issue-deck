import { needsReviewAttention } from "@/lib/github/pull-request-review-verdict";
import { isSystemBranch } from "@/lib/system-branch";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 自動マージが保留される理由の1件（#4377）。
 *
 * **表示のために自動マージ側へ問い合わせたり、判定を再実装したりしない。** 材料は一覧・詳細が
 * 既に持っているPRの状態（対応Issue・`00.check-user`・自動レビューの判定・判定ジョブの進み具合）
 * だけで、`claude-review-develop.yml`が結論を書く場所（対応Issueの`00.check-user`・PR本文の
 * `## 検証結果`）をそのまま読む。DBスキーマ変更などの具体的な理由は、読める根拠が無い限り
 * 推測で補わない。
 */
export type MergeHoldReason = {
  kind: "release" | "issue-unknown" | "check-user" | "review";
  /** 画面に出す1行 */
  text: string;
  /** 関連Issue（`issue-unknown`以外で対応Issueが分かるとき） */
  issueNumber: number | null;
};

/**
 * - `held` … 理由が確定した保留。`reasons`が1件以上ある
 * - `pending` … 判定ジョブが走っている最中で、まだ決まっていない
 * - `unknown` … 判定の結果を読めない（未実施・取得不可）。**保留とも成功とも言わない**
 * - `none` … 保留の理由は見つからない（自動マージされうる、または対象外）
 */
export type MergeHoldStatus = "held" | "pending" | "unknown" | "none";

export type MergeHold = {
  status: MergeHoldStatus;
  reasons: MergeHoldReason[];
  /** `pending`・`unknown`のときの説明 */
  note: string | null;
};

const CHECK_USER_REASON_LABEL = {
  plan: "計画の承認待ち",
  input: "質問への回答待ち",
  merge: "マージ前の確認待ち",
  blocked: "作業が止まっています",
  answered: "回答済みの確認待ち",
} as const;

function reviewReasonText(pullRequest: PullRequestSummary): string | null {
  const verdict = pullRequest.reviewVerdict;
  if (!verdict || !needsReviewAttention(verdict.reviewKind)) return null;
  const stale =
    verdict.reviewedSha !== null &&
    verdict.reviewedSha.toLowerCase() !== pullRequest.headSha.toLowerCase();
  const base =
    verdict.reviewKind === "changes-requested" ? "レビューが要修正です" : "レビューが要確認です";
  return stale ? `${base}（この判定の後にコミットが積まれています）` : base;
}

/**
 * PRの自動マージが保留される理由を、いまの状態から導く（#4377）。
 *
 * 表示は実際のマージ判定と同じ根拠（`requiresUserMerge`が読む`linkedIssueCheckUser`など）に
 * 基づく。**CIとレビューが緑でも「自動マージ可能」とは言わない**——緑でないことも緑であることも、
 * 保留理由の有無とは別の軸。
 */
export function deriveMergeHold(pullRequest: PullRequestSummary): MergeHold {
  const none: MergeHold = { status: "none", reasons: [], note: null };
  if (pullRequest.state !== "open" || pullRequest.merged || pullRequest.draft) return none;
  if (pullRequest.kind === "version-bump") return none;

  if (pullRequest.mergeJudgement.state === "pending") {
    return {
      status: "pending",
      reasons: [],
      note: "自動マージの判定が進行中です。結果が出るまで保留かどうかは決まっていません。",
    };
  }

  const reasons: MergeHoldReason[] = [];

  if (pullRequest.kind === "release") {
    reasons.push({
      kind: "release",
      text: "develop→mainのリリースPRは、人がマージします",
      issueNumber: null,
    });
  } else if (!pullRequest.autoMergeEnabled) {
    const issueNumber = pullRequest.linkedIssueNumber;
    if (issueNumber === null) {
      // 対応Issueを持たないPRは、自動レビューの「問題なし」が出れば自動マージされる（#4952）。
      // ここへ来るのは判定が終わった・読めないのに予約されていないときなので、その条件を添える。
      // システムブランチ（リリース同期など）は専用の経路がマージするので、保留理由にしない
      if (!isSystemBranch(pullRequest.headRef)) {
        reasons.push({
          kind: "issue-unknown",
          text: "対応Issueを特定できないPRで、自動レビューの「問題なし」が得られていません",
          issueNumber: null,
        });
      }
    } else {
      const checkUserReason = pullRequest.linkedIssueCheckReason;
      if (checkUserReason !== null || pullRequest.linkedIssueCheckUser) {
        const detail = checkUserReason ? `：${CHECK_USER_REASON_LABEL[checkUserReason]}` : "";
        reasons.push({
          kind: "check-user",
          text: `ユーザー確認待ち（Issue #${issueNumber}${detail}）`,
          issueNumber,
        });
      }
    }
  }

  const review = reviewReasonText(pullRequest);
  if (review) {
    reasons.push({ kind: "review", text: review, issueNumber: pullRequest.linkedIssueNumber });
  }

  if (reasons.length > 0) return { status: "held", reasons, note: null };

  if (pullRequest.autoMergeEnabled) return none;

  if (pullRequest.mergeJudgement.state === "unknown") {
    return {
      status: "unknown",
      reasons: [],
      note: "自動マージの判定を確認できません（未実施、またはチェックを取得できませんでした）。",
    };
  }
  return none;
}

/** 確認なしの通常マージを止める対象か（レビューが要修正・要確認で、判定が古いと分かっていない） */
export function needsReviewMergeConfirmation(pullRequest: PullRequestSummary): boolean {
  const verdict = pullRequest.reviewVerdict;
  if (!verdict || !needsReviewAttention(verdict.reviewKind)) return false;
  if (verdict.reviewedSha === null) return true;
  return verdict.reviewedSha.toLowerCase() === pullRequest.headSha.toLowerCase();
}
