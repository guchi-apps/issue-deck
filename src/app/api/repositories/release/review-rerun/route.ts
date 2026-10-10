import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { rerunReleaseReviewJob } from "@/lib/dispatch/release-review-jobs";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import { registerReleaseVerification } from "@/lib/release-verification";

/**
 * 全体レビューの再実行（#4300）。実行障害（失敗・未完了）のとき、コードを直さずに同じ対象でやり直す。
 *
 * **対象（base・head）はクライアントの値ではなく、サーバーが今のリリースPRから解決する。** クライアントが
 * 送ったSHAは「押したときに見ていた対象」との一致確認だけに使い、ずれていれば409で止める
 * （古い画面から別の対象を走らせない）。同じ対象に実行中・待機中のジョブがあれば積まない
 * （`already_queued`。重複防止は`requestReleaseReviewJob`の`activeKey`）。
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
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    !expectedBase ||
    !expectedHead
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: { fullName: `${owner}/${repo}`, installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pr = await fetchPullRequest(owner, repo, pullRequestNumber, token);
    if (!pr.base || !pr.head.ref || !isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })) {
      return NextResponse.json({ error: "not_release_pull_request" }, { status: 404 });
    }
    if (pr.base.sha !== expectedBase || pr.head.sha !== expectedHead) {
      return NextResponse.json({ error: "release_pr_changed" }, { status: 409 });
    }
    const target = { repoFullName: `${owner}/${repo}`, prNumber: pullRequestNumber, baseSha: pr.base.sha, headSha: pr.head.sha };
    await registerReleaseVerification(target);
    const result = await rerunReleaseReviewJob(target);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.rejection, message: result.message }, { status: 409 });
    }
    return NextResponse.json({ ok: true, outcome: result.outcome }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[POST /api/repositories/release/review-rerun] ${owner}/${repo}#${pullRequestNumber}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
