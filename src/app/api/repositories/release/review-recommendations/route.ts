import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { generateReleaseReviewRecommendations } from "@/lib/claude/release-review-recommend";
import { getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import { releaseDecisionScopeKey, resolveReleaseDecisionChain } from "@/lib/release-review-decision-store";
import type { RecommendationTarget } from "@/lib/release-review-recommendation";
import { loadOrGenerateRecommendations } from "@/lib/release-review-recommendation-store";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";

/**
 * 全体レビューの指摘ごとのAIの推奨判断と理由案（#4676）を返す。保存済みが無い指摘はこの場でAIに作らせる。
 * **推奨を作るだけで、判断は保存しない**（確定は`review-decisions`へユーザーが送る）。
 *
 * - ガードは判断API（`review-decisions`）と同じ: プレビュー→ログイン→所有確認→今のリリースPRの再取得→SHAの一致
 * - 対象は、今の結果にある指摘のうち**有効な判断が無いもの**（未判断・前提が変わって再確認が必要なもの）だけ。
 *   確定済みの判断には推奨を作らない（新しい推奨で判断を上書きして見せない）
 * - 失敗した指摘は記録して返し、`retry: true`（画面の「推奨を再取得」）のときだけ作り直す
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_dispatch", () => handlePOST(request));
}

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
  if (typeof owner !== "string" || typeof repo !== "string" || !Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0 || !expectedBase || !expectedHead) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const retry = payload?.retry === true;

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
      return NextResponse.json({ error: "release_pr_changed", message: "リリース候補が更新されました。画面を更新してください" }, { status: 409 });
    }
    const current = { baseSha: pr.base.sha, headSha: pr.head.sha };
    const summary = await loadReleaseVerificationSummary(repoFullName, pullRequestNumber, current);
    const section = summary.aiReview;
    if (section.state !== "needs_check" && section.state !== "passed") {
      return NextResponse.json({ status: "ready", byFinding: {}, failures: {} }, { headers: { "Cache-Control": "no-store" } });
    }
    const targets: RecommendationTarget[] = [];
    for (const [list, blocking] of [[section.findings, true], [section.suggestions, false]] as const) {
      for (const f of list) {
        if (!f.id) continue;
        const view = section.decisions?.byFinding[f.id];
        if (view?.current && !view.stale) continue;
        targets.push({
          ...f,
          id: f.id,
          blocking,
          previousDecision: view?.current && view.stale ? { decision: view.current.decision, reason: view.current.reason, stale: view.stale } : null,
        });
      }
    }
    const chain = await resolveReleaseDecisionChain(repoFullName, pullRequestNumber);
    const aiToken = await getAppAiToken("release_review_recommend");
    const view = await loadOrGenerateRecommendations({
      key: { scopeKey: releaseDecisionScopeKey(repoFullName, chain), ...current },
      repoFullName,
      prNumber: pullRequestNumber,
      targets,
      retry,
      generate: aiToken
        ? (batch) => generateReleaseReviewRecommendations(aiToken, { repoFullName, prNumber: pullRequestNumber, findings: batch })
        : null,
    });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[POST /api/repositories/release/review-recommendations] ${repoFullName}#${pullRequestNumber}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
