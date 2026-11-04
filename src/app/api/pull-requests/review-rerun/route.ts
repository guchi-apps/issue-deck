import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import {
  convertPullRequestToDraft,
  fetchWorkflowRunsForHead,
  markPullRequestReadyForReview,
  rerunWorkflowRun,
} from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/issues-api";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { previewModeGuard } from "@/lib/preview-mode";
import { decideReviewRerun, decideReviewRestart, isWorkflowRunRetryRefused } from "@/lib/pull-request-review-rerun";

/** 下書きからレビュー可能へ戻す試行。失敗するとPRが下書きのまま残るので、一時的な失敗は吸収する */
const READY_ATTEMPTS = 3;
const READY_RETRY_DELAY_MS = 500;

/**
 * 再実行を断られたrunの代わりに、下書き→レビュー可能の往復で`ready_for_review`のrunを起こす（#5212）。
 * 下書きへ戻す前のPRの判定は`decideReviewRestart`。
 */
async function restartReviewViaDraft(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  token: string,
): Promise<NextResponse> {
  const latest = await fetchPullRequest(owner, repo, number, token);
  const decision = decideReviewRestart(
    {
      state: latest.state,
      merged: latest.merged,
      draft: latest.draft,
      baseRef: latest.base.ref,
      headSha: latest.head.sha,
      nodeId: latest.node_id,
    },
    headSha,
  );
  if (decision.action === "reject") return NextResponse.json({ error: decision.code }, { status: 409 });

  try {
    await convertPullRequestToDraft(decision.nodeId, token);
  } catch (error) {
    console.error(`[POST /api/pull-requests/review-rerun] ${owner}/${repo}#${number} 下書きへ戻せません:`, error);
    return NextResponse.json({ error: "restart_failed" }, { status: 502 });
  }

  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, READY_RETRY_DELAY_MS * attempt));
    try {
      await markPullRequestReadyForReview(decision.nodeId, token);
      return NextResponse.json({ ok: true, method: "restart" });
    } catch (error) {
      console.error(`[POST /api/pull-requests/review-rerun] ${owner}/${repo}#${number} レビュー可能へ戻せません:`, error);
    }
  }
  return NextResponse.json({ error: "ready_failed" }, { status: 502 });
}

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
    try {
      await rerunWorkflowRun(owner, repo, decision.runId, false, token);
    } catch (error) {
      if (error instanceof GithubApiError && isWorkflowRunRetryRefused(error.status, error.message)) {
        return await restartReviewViaDraft(owner, repo, number, headSha, token);
      }
      throw error;
    }
    return NextResponse.json({ ok: true, method: "rerun", runId: decision.runId });
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
