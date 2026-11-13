import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import { generateRecommendationsForTarget } from "@/lib/release-review-recommendation-prefetch";

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
    const view = await generateRecommendationsForTarget({ repoFullName, prNumber: pullRequestNumber, current, retry });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[POST /api/repositories/release/review-recommendations] ${repoFullName}#${pullRequestNumber}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
