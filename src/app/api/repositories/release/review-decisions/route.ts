import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { createComment, createIssue, fetchIssueStateOrThrow } from "@/lib/github/issues-api";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import {
  parseReleaseReviewDecisionAction,
  RELEASE_REVIEW_DECISION_LABEL,
  validateDecisionInput,
} from "@/lib/release-review-decision";
import {
  releaseDecisionScopeKey,
  resolveReleaseDecisionChain,
  saveReleaseReviewDecision,
} from "@/lib/release-review-decision-store";
import { classifyReasonSource } from "@/lib/release-review-recommendation";
import { findUsableRecommendation } from "@/lib/release-review-recommendation-store";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";

/**
 * 全体レビューの指摘1件に、ユーザーの判断（今回直す／公開後に対応する／今回は見送る／採用しない／撤回）を
 * 記録する（#4657）。**判断の保存だけではマージしない・修正Issueも作らない。**
 *
 * - ガードは再実行（`review-rerun`）と同じ: プレビュー→ログイン→リポジトリの所有確認→今のリリースPRの再取得
 * - 対象（base・head）はサーバーが今のPRから解決し、クライアントのSHAは一致確認だけに使う（古い画面からは409）
 * - 指摘は今の結果に載っているIDだけを受け付ける（見ていない・古い結果の指摘に判断を付けない）
 * - 同時判断は`expectedDecisionId`（画面が見ていた最新の判断）で止め、黙って上書きしない（409 `decision_conflict`）
 * - 公開後対応の関連Issueは、既存の番号（存在を確認）か、この操作で明示的に作るものだけ。見送りには作らない
 * - 外部エージェント用のAPI（review-agent）にはこの書き込み口を作らない。採否はユーザーが決める
 * - AIの推奨（#4676）を見て判断したときは`recommendationId`を受け取り、推奨の写しと理由の出どころを判断と一緒に残す。
 *   推奨は今の対象（base・head）・同じ指摘のものだけを受け付け、別の対象の推奨なら409で止める
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_dispatch", () => handlePOST(request));
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const pullRequestNumber = payload?.pullRequestNumber;
  const sha = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v) ? v : null);
  const expectedBase = sha(payload?.baseSha);
  const expectedHead = sha(payload?.headSha);
  const findingId = typeof payload?.findingId === "string" && /^R-[0-9a-f]{6}$/.test(payload.findingId) ? payload.findingId : null;
  const decision = parseReleaseReviewDecisionAction(payload?.decision);
  const expectedDecisionId =
    payload?.expectedDecisionId === null ? null : typeof payload?.expectedDecisionId === "string" ? payload.expectedDecisionId : undefined;
  const recommendationId =
    payload?.recommendationId === undefined || payload?.recommendationId === null
      ? null
      : typeof payload.recommendationId === "string" && /^[a-z0-9]{1,40}$/.test(payload.recommendationId)
        ? payload.recommendationId
        : undefined;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    !expectedBase ||
    !expectedHead ||
    !findingId ||
    !decision ||
    expectedDecisionId === undefined ||
    recommendationId === undefined
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const rawFollowUp = payload?.followUp;
  const followUpInput =
    rawFollowUp?.kind === "existing" && Number.isInteger(rawFollowUp.number) && rawFollowUp.number > 0
      ? { kind: "existing" as const, number: rawFollowUp.number as number }
      : rawFollowUp?.kind === "create"
        ? { kind: "create" as const, title: str(rawFollowUp.title, 200) ?? "" }
        : null;
  const input = {
    decision,
    reason: str(payload?.reason, 2000) ?? "",
    impact: str(payload?.impact, 2000),
    scope: str(payload?.scope, 2000),
    timing: str(payload?.timing, 500),
    followUp: followUpInput,
  };
  const invalid = validateDecisionInput(input);
  if (invalid) return NextResponse.json({ error: "invalid_decision", ...invalid }, { status: 400 });

  const repoFullName = `${owner}/${repo}`;
  const repository = await db.repository.findFirst({
    where: { fullName: repoFullName, installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pr = await fetchPullRequest(owner, repo, pullRequestNumber, token);
    if (!pr.base || !pr.head.ref || !isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })) {
      return NextResponse.json({ error: "not_release_pull_request" }, { status: 404 });
    }
    if ((pr as { state?: string }).state === "closed" || pr.base.sha !== expectedBase || pr.head.sha !== expectedHead) {
      return NextResponse.json({ error: "release_pr_changed", message: "リリース候補が更新されました。画面を更新してから判断してください" }, { status: 409 });
    }
    const current = { baseSha: pr.base.sha, headSha: pr.head.sha };
    const summary = await loadReleaseVerificationSummary(repoFullName, pullRequestNumber, current);
    const section = summary.aiReview;
    const blockingFinding = section.findings.find((f) => f.id === findingId);
    const finding = blockingFinding ?? section.suggestions.find((f) => f.id === findingId);
    if (!finding || (section.state !== "needs_check" && section.state !== "passed")) {
      return NextResponse.json(
        { error: "finding_not_current", message: "この指摘は今の全体レビューの結果にありません。画面を更新してください" },
        { status: 409 },
      );
    }

    // 競合を先に確かめる。公開後対応のIssueを作ってから競合で保存できない、という順を避ける
    const view = section.decisions?.byFinding[findingId];
    const latest = view?.history.at(-1) ?? null;
    if ((latest?.id ?? null) !== expectedDecisionId) {
      return NextResponse.json(
        { error: "decision_conflict", message: "ほかの操作でこの指摘の判断が更新されました。最新の判断を確認してから保存してください", latest },
        { status: 409 },
      );
    }
    const chain = await resolveReleaseDecisionChain(repoFullName, pullRequestNumber);
    const scopeKey = releaseDecisionScopeKey(repoFullName, chain);
    // 判断の根拠にした推奨。今の対象・同じ指摘のものでなければ、古い推奨で保存しない（Issueを作る前に確かめる）
    const recommendation = recommendationId
      ? await findUsableRecommendation(recommendationId, { scopeKey, findingId, ...current })
      : null;
    if (recommendationId && !recommendation) {
      return NextResponse.json(
        { error: "recommendation_stale", message: "AIの推奨が今の対象のものではありません。画面を更新して推奨を確認し直してください" },
        { status: 409 },
      );
    }

    // 公開後対応の関連Issue。既存の番号は存在を確かめ、新規作成はユーザーが明示したときだけ
    let followUp: { repo: string; number: number } | null = null;
    if (input.followUp?.kind === "existing") {
      const state = await fetchIssueStateOrThrow(owner, repo, input.followUp.number, token);
      if (!state) return NextResponse.json({ error: "invalid_decision", field: "followUp", message: `#${input.followUp.number} が見つかりません` }, { status: 400 });
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

    const saved = await saveReleaseReviewDecision({
      scopeKey,
      repoFullName,
      findingId,
      aliasIds: view?.aliasIds ?? [],
      expectedDecisionId,
      decision,
      reason: input.reason,
      impact: decision === "defer" ? input.impact : null,
      scope: decision === "defer" ? input.scope : null,
      followUp,
      timing: decision === "post_release" ? input.timing : null,
      prNumber: pullRequestNumber,
      headRef: pr.head.ref,
      baseSha: current.baseSha,
      headSha: current.headSha,
      severity: finding.severity,
      blocking: Boolean(blockingFinding),
      findingTitle: finding.title,
      userId,
      recommendation: recommendation
        ? { id: recommendation.id, decision: recommendation.recommended, reason: recommendation.drafts[recommendation.recommended].reason }
        : null,
      reasonSource: classifyReasonSource(recommendation, decision, input.reason),
    });
    if (!saved.ok) {
      return NextResponse.json(
        { error: saved.error, message: "ほかの操作でこの指摘の判断が更新されました。最新の判断を確認してから保存してください", latest: saved.latest },
        { status: 409 },
      );
    }
    // 既存のIssueへ関連付けたときは、どの指摘を受け持つのかを残す（失敗しても判断は保存済み）
    if (input.followUp?.kind === "existing" && followUp) {
      await createComment(owner, repo, followUp.number, token, {
        body: `リリース候補 #${pullRequestNumber} の全体レビューの指摘 ${findingId}「${finding.title}」を、このIssueで公開後に対応すると判断しました（${RELEASE_REVIEW_DECISION_LABEL[decision]}・実施時期: ${input.timing}）。\n\n判断の理由: ${input.reason}\n\n<!-- issue-deck:release-review-decision -->`,
      }).catch((error: unknown) => console.error("[review-decisions] follow-up comment failed", error));
    }
    const activeSeries = await db.releaseFixSeries.count({
      where: {
        repositoryFullName: repoFullName,
        releasePrNumber: { in: chain },
        sourceKind: "review_finding",
        status: { in: ["issue_created", "fix_in_progress", "fix_merged", "awaiting_decision", "rebuilding", "reverifying"] },
      },
    });
    return NextResponse.json(
      {
        ok: true,
        decision: saved.record,
        // 稼働中の修正系列がある場合、実行中のセッション・取り込み済みの修正PRは止まらない。今後の追加修正・候補更新だけが判断に従う
        activeFixSeries: activeSeries,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error(`[POST /api/repositories/release/review-decisions] ${repoFullName}#${pullRequestNumber}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
