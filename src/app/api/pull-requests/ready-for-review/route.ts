import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { markPullRequestReadyForReview } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/issues-api";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { previewModeGuard } from "@/lib/preview-mode";
import { decideReadyForReview } from "@/lib/pull-request-ready-for-review";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_ready_for_review", () => handlePOST(request));
}

/**
 * PR詳細の「レビュー可能にする」（#4453）。ドラフトを解除するだけで、マージ・リリースはしない。
 *
 * 画面の値は信用せず、GitHubから現在のPRを取り直して`decideReadyForReview`で判定する。
 * 既にレビュー可能なら**mutationを撃たず**`alreadyReady`で成功を返し、画面に最新状態を取り直させる。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const current = await fetchPullRequest(owner, repo, number, token);
    const decision = decideReadyForReview(
      { state: current.state, merged: current.merged, draft: current.draft, headSha: current.head.sha },
      headSha,
    );
    if (decision.action === "reject") {
      return NextResponse.json({ error: decision.code }, { status: 409 });
    }
    if (decision.action === "already_ready") {
      return NextResponse.json({ ok: true, alreadyReady: true });
    }
    if (!current.node_id) {
      return NextResponse.json({ error: "github_api_error", message: "PRのNode IDを取得できませんでした" }, { status: 502 });
    }
    await markPullRequestReadyForReview(current.node_id, token);
    return NextResponse.json({ ok: true, alreadyReady: false });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof GithubApiError && error.status === 403) {
      return NextResponse.json({ error: "permission_denied" }, { status: 403 });
    }
    console.error(`[POST /api/pull-requests/ready-for-review] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
