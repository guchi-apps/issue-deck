import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/issues-api";
import { rerunPullRequestReview } from "@/lib/github/pull-request-review-rerun-run";
import { previewModeGuard } from "@/lib/preview-mode";

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
    const outcome = await rerunPullRequestReview({ owner, repo, number, headSha, token });
    if (outcome.ok) return NextResponse.json(outcome);
    return NextResponse.json({ error: outcome.code }, { status: outcome.kind === "rejected" ? 409 : 502 });
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
