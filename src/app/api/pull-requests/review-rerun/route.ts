import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchWorkflowRunsForHead, rerunWorkflowRun } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/issues-api";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { previewModeGuard } from "@/lib/preview-mode";
import { decideReviewRerun } from "@/lib/pull-request-review-rerun";

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_review_rerun", () => handlePOST(request));
}

/**
 * PR詳細の「AIレビューを再実行」（#5158）。現在のHEADに対する`claude-review-develop.yml`のrunを
 * 再実行する。指摘の前提（secretの同期など、人の作業）が解消したのに、コミットが変わらないため
 * 判定が古いまま残る、という状況を画面だけで片付けるための操作。判定は`decideReviewRerun`。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload: { owner?: unknown; repo?: unknown; number?: unknown; headSha?: unknown } = await request
    .json()
    .catch(() => ({}));
  const { owner, repo, number, headSha } = payload;
  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    typeof headSha !== "string" ||
    !headSha
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
    const current = await fetchPullRequest(owner, repo, number, token);
    const runs = (await fetchWorkflowRunsForHead(owner, repo, current.head.sha, token)).map((run) => ({
      id: run.id,
      name: run.name,
      path: run.path,
      status: run.status ?? "unknown",
      conclusion: run.conclusion,
      headSha: run.head_sha,
      event: run.event,
      htmlUrl: run.html_url,
    }));
    const decision = decideReviewRerun(
      { state: current.state, merged: current.merged, baseRef: current.base.ref, headSha: current.head.sha },
      headSha,
      runs,
    );
    if (decision.action === "reject") return NextResponse.json({ error: decision.code }, { status: 409 });
    await rerunWorkflowRun(owner, repo, decision.runId, false, token);
    return NextResponse.json({ ok: true, runId: decision.runId });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof GithubApiError && error.status === 403) {
      return NextResponse.json({ error: "permission_denied" }, { status: 403 });
    }
    console.error(`[POST /api/pull-requests/review-rerun] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
