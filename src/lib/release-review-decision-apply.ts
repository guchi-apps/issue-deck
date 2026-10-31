import { db } from "@/lib/db";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { createComment, createIssue, fetchIssueStateOrThrow } from "@/lib/github/issues-api";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import {
  RELEASE_REVIEW_DECISION_LABEL,
  type ReleaseReviewDecisionAction,
  type ReleaseReviewDecisionRecord,
} from "@/lib/release-review-decision";
import {
  releaseDecisionScopeKey,
  resolveReleaseDecisionChain,
  saveReleaseReviewDecision,
} from "@/lib/release-review-decision-store";
import { classifyReasonSource, type ReasonSource } from "@/lib/release-review-recommendation";
import { findUsableRecommendation } from "@/lib/release-review-recommendation-store";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

/**
 * 全体レビューの指摘への判断を1件確定する処理（#4657）を、1件ずつの判断API（`review-decisions`）と
 * 一括確定API（`review-decisions/bulk`・#5138）で共有する。**ガードの順序は1件ずつのAPIのまま**:
 * 今のリリースPRを取り直して画面のSHAと照合 → 指摘が今の結果にあるか → 競合（`expectedDecisionId`）→
 * 推奨が今の対象のものか → 公開後対応のIssueを作る → 保存。Issueを作ってから競合で保存できない順を避ける。
 */

export type DecisionFailure = { ok: false; status: number; body: Record<string, unknown> };

export type DecisionContext = {
  owner: string;
  repo: string;
  repoFullName: string;
  token: string;
  pullRequestNumber: number;
  headRef: string;
  current: { baseSha: string; headSha: string };
  section: ReleaseVerificationSummary["aiReview"];
  scopeKey: string;
  chain: number[];
  userId: string;
};

/** 今のリリースPRと全体レビューの結果を読み、画面が見ていた対象と同じかを確かめる */
export async function loadDecisionContext(params: {
  owner: string;
  repo: string;
  token: string;
  pullRequestNumber: number;
  expectedBase: string;
  expectedHead: string;
  userId: string;
}): Promise<{ ok: true; ctx: DecisionContext } | DecisionFailure> {
  const { owner, repo, token, pullRequestNumber } = params;
  const repoFullName = `${owner}/${repo}`;
  const pr = await fetchPullRequest(owner, repo, pullRequestNumber, token);
  if (!pr.base || !pr.head.ref || !isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })) {
    return { ok: false, status: 404, body: { error: "not_release_pull_request" } };
  }
  if ((pr as { state?: string }).state === "closed" || pr.base.sha !== params.expectedBase || pr.head.sha !== params.expectedHead) {
    return {
      ok: false,
      status: 409,
      body: { error: "release_pr_changed", message: "リリース候補が更新されました。画面を更新してから判断してください" },
    };
  }
  const current = { baseSha: pr.base.sha, headSha: pr.head.sha };
  const summary = await loadReleaseVerificationSummary(repoFullName, pullRequestNumber, current);
  const chain = await resolveReleaseDecisionChain(repoFullName, pullRequestNumber);
  return {
    ok: true,
    ctx: {
      owner,
      repo,
      repoFullName,
      token,
      pullRequestNumber,
      headRef: pr.head.ref,
      current,
      section: summary.aiReview,
      scopeKey: releaseDecisionScopeKey(repoFullName, chain),
      chain,
      userId: params.userId,
    },
  };
}

export type DecisionInput = {
  findingId: string;
  decision: ReleaseReviewDecisionAction;
  reason: string;
  impact: string | null;
  scope: string | null;
  timing: string | null;
  followUp: { kind: "existing"; number: number } | { kind: "create"; title: string } | null;
  expectedDecisionId: string | null;
  recommendationId: string | null;
  /** 理由の出どころを推奨との比較で決めず、この値で残す（一括確定の安全側`fallback`） */
  reasonSourceOverride?: ReasonSource;
};

/** 判断を1件確定する。入力の形の検証（`validateDecisionInput`）は呼び出し側で済ませておく */
export async function applyReleaseReviewDecision(
  ctx: DecisionContext,
  input: DecisionInput,
): Promise<{ ok: true; record: ReleaseReviewDecisionRecord } | DecisionFailure> {
  const { owner, repo, repoFullName, token, pullRequestNumber, section, findingId } = { ...ctx, findingId: input.findingId };
  const blockingFinding = section.findings.find((f) => f.id === findingId);
  const finding = blockingFinding ?? section.suggestions.find((f) => f.id === findingId);
  if (!finding || (section.state !== "needs_check" && section.state !== "passed")) {
    return {
      ok: false,
      status: 409,
      body: { error: "finding_not_current", message: "この指摘は今の全体レビューの結果にありません。画面を更新してください" },
    };
  }

  // 競合を先に確かめる。公開後対応のIssueを作ってから競合で保存できない、という順を避ける
  const view = section.decisions?.byFinding[findingId];
  const latest = view?.history.at(-1) ?? null;
  if ((latest?.id ?? null) !== input.expectedDecisionId) {
    return {
      ok: false,
      status: 409,
      body: { error: "decision_conflict", message: "ほかの操作でこの指摘の判断が更新されました。最新の判断を確認してから保存してください", latest },
    };
  }
  // 判断の根拠にした推奨。今の対象・同じ指摘のものでなければ、古い推奨で保存しない（Issueを作る前に確かめる）
  const recommendation = input.recommendationId
    ? await findUsableRecommendation(input.recommendationId, { scopeKey: ctx.scopeKey, findingId, ...ctx.current })
    : null;
  if (input.recommendationId && !recommendation) {
    return {
      ok: false,
      status: 409,
      body: { error: "recommendation_stale", message: "AIの推奨が今の対象のものではありません。画面を更新して推奨を確認し直してください" },
    };
  }

  // 公開後対応の関連Issue。既存の番号は存在を確かめ、新規作成はユーザーが明示したときだけ
  let followUp: { repo: string; number: number } | null = null;
  if (input.followUp?.kind === "existing") {
    const state = await fetchIssueStateOrThrow(owner, repo, input.followUp.number, token);
    if (!state) {
      return { ok: false, status: 400, body: { error: "invalid_decision", field: "followUp", message: `#${input.followUp.number} が見つかりません` } };
    }
    followUp = { repo: repoFullName, number: input.followUp.number };
  } else if (input.followUp?.kind === "create") {
    const created = await createIssue(owner, repo, token, {
      title: input.followUp.title,
      body: [
        "## 目的",
        `リリース候補 #${pullRequestNumber} の全体レビューの指摘 ${findingId}「${finding.title}」を、本番公開後の作業として対応する。`,
        "",
        "## 背景",
        `全体レビューの指摘に対して、ユーザーが「公開後に対応する」と判断した（実施時期: ${input.timing}）。`,
        "",
        `判断の理由: ${input.reason}`,
        "",
        "## 関連",
        `- リリース候補: #${pullRequestNumber}`,
      ].join("\n"),
    });
    followUp = { repo: repoFullName, number: created.number };
  }

  const decision = input.decision;
  const saved = await saveReleaseReviewDecision({
    scopeKey: ctx.scopeKey,
    repoFullName,
    findingId,
    aliasIds: view?.aliasIds ?? [],
    expectedDecisionId: input.expectedDecisionId,
    decision,
    reason: input.reason,
    impact: decision === "defer" ? input.impact : null,
    scope: decision === "defer" ? input.scope : null,
    followUp,
    timing: decision === "post_release" ? input.timing : null,
    prNumber: pullRequestNumber,
    headRef: ctx.headRef,
    baseSha: ctx.current.baseSha,
    headSha: ctx.current.headSha,
    severity: finding.severity,
    blocking: Boolean(blockingFinding),
    findingTitle: finding.title,
    userId: ctx.userId,
    recommendation: recommendation
      ? { id: recommendation.id, decision: recommendation.recommended, reason: recommendation.drafts[recommendation.recommended].reason }
      : null,
    reasonSource: input.reasonSourceOverride ?? classifyReasonSource(recommendation, decision, input.reason),
  });
  if (!saved.ok) {
    return {
      ok: false,
      status: 409,
      body: { error: saved.error, message: "ほかの操作でこの指摘の判断が更新されました。最新の判断を確認してから保存してください", latest: saved.latest },
    };
  }
  // 既存のIssueへ関連付けたときは、どの指摘を受け持つのかを残す（失敗しても判断は保存済み）
  if (input.followUp?.kind === "existing" && followUp) {
    await createComment(owner, repo, followUp.number, token, {
      body: `リリース候補 #${pullRequestNumber} の全体レビューの指摘 ${findingId}「${finding.title}」を、このIssueで公開後に対応すると判断しました（${RELEASE_REVIEW_DECISION_LABEL[decision]}・実施時期: ${input.timing}）。\n\n判断の理由: ${input.reason}\n\n<!-- issue-deck:release-review-decision -->`,
    }).catch((error: unknown) => console.error("[review-decisions] follow-up comment failed", error));
  }
  return { ok: true, record: saved.record };
}

/** 稼働中の修正系列の数。実行中のセッション・取り込み済みの修正PRは判断で止まらないことを画面へ伝えるのに使う */
export function countActiveReviewFixSeries(ctx: Pick<DecisionContext, "repoFullName" | "chain">): Promise<number> {
  return db.releaseFixSeries.count({
    where: {
      repositoryFullName: ctx.repoFullName,
      releasePrNumber: { in: ctx.chain },
      sourceKind: "review_finding",
      status: { in: ["issue_created", "fix_in_progress", "fix_merged", "awaiting_decision", "rebuilding", "reverifying"] },
    },
  });
}
