import { generateReleaseReviewRecommendations } from "@/lib/claude/release-review-recommend";
import { getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import { releaseDecisionScopeKey, resolveReleaseDecisionChain } from "@/lib/release-review-decision-store";
import type { RecommendationTarget, ReleaseReviewRecommendationsView } from "@/lib/release-review-recommendation";
import { loadOrGenerateRecommendations } from "@/lib/release-review-recommendation-store";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";

/**
 * 全体レビューの指摘ごとのAIの推奨（#4676）を、対象（base・head）に対して作って保存する共通処理。
 * 画面を開いた時の`POST /api/repositories/release/review-recommendations`と、全体レビューの完了報告を
 * 受けた時の事前取得（#5357）が同じ経路を通る。**認可はここでは行わない**（呼び出し側が済ませる）。
 */
const inflight = new Map<string, Promise<ReleaseReviewRecommendationsView>>();

/** 同じ対象の生成が実行中なら、その結果を共有する（事前取得中に画面を開いても二重にAIを呼ばない。プロセス内のみ） */
export function generateRecommendationsForTarget(input: {
  repoFullName: string;
  prNumber: number;
  current: { baseSha: string; headSha: string };
  retry: boolean;
}): Promise<ReleaseReviewRecommendationsView> {
  const key = `${input.repoFullName}#${input.prNumber}:${input.current.baseSha}:${input.current.headSha}:${input.retry}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = runGenerate(input).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function runGenerate(input: {
  repoFullName: string;
  prNumber: number;
  current: { baseSha: string; headSha: string };
  retry: boolean;
}): Promise<ReleaseReviewRecommendationsView> {
  const { repoFullName, prNumber, current } = input;
  const summary = await loadReleaseVerificationSummary(repoFullName, prNumber, current);
  const section = summary.aiReview;
  if (section.state !== "needs_check" && section.state !== "passed") {
    return { status: "ready", byFinding: {}, failures: {} };
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
  const chain = await resolveReleaseDecisionChain(repoFullName, prNumber);
  const aiToken = await getAppAiToken("release_review_recommend");
  return loadOrGenerateRecommendations({
    key: { scopeKey: releaseDecisionScopeKey(repoFullName, chain), ...current },
    repoFullName,
    prNumber,
    targets,
    retry: input.retry,
    generate: aiToken
      ? (batch) => generateReleaseReviewRecommendations(aiToken, { repoFullName, prNumber, findings: batch })
      : null,
  });
}

/**
 * 全体レビューの結果が記録された直後に、画面を開く前へ推奨を作っておく（#5357）。**失敗しても投げない**
 * （報告の処理を巻き込まない。作れなかった指摘は、画面を開いた時に従来どおり作り直す）。
 * リリースPR（main向けの`release-main/*`）が今もその対象（base・head）のときだけ作る
 */
export async function prefetchReleaseReviewRecommendations(
  repoFullName: string,
  prNumber: number,
  current: { baseSha: string; headSha: string },
): Promise<void> {
  try {
    const repository = await db.repository.findFirst({ where: { fullName: repoFullName }, include: { installation: true } });
    if (!repository) return;
    const [owner, repo] = repoFullName.split("/");
    const token = await getInstallationToken(repository.installation.installationId);
    const pr = await fetchPullRequest(owner, repo, prNumber, token);
    if (!pr.base || !pr.head.ref || !isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })) return;
    if ((pr as { state?: string }).state === "closed" || pr.base.sha !== current.baseSha || pr.head.sha !== current.headSha) return;
    await generateRecommendationsForTarget({ repoFullName, prNumber, current, retry: false });
  } catch (error) {
    console.error(`[prefetchReleaseReviewRecommendations] ${repoFullName}#${prNumber}:`, error);
  }
}
