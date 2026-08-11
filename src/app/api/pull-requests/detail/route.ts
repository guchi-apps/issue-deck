import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchCommentsForIssue } from "@/lib/github/issues-api";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { buildPullRequestEvents } from "@/lib/github/pull-request-events";
import {
  fetchPullRequest,
  fetchPullRequestReviewComments,
  fetchPullRequestReviews,
} from "@/lib/github/pull-requests-api";
import type { PullRequestDetail } from "@/types/pull-request";

export function GET(request: NextRequest) {
  return withGithubApiFeature("pull_request_detail", () => handleGET(request));
}

/**
 * PR1件の本文とコメントを取得する。一覧（`/api/pull-requests`）と同じくキャッシュせず
 * 都度GitHub APIから読む。1回で4リクエスト（PR本体・会話コメント・レビュー・レビューコメント）を
 * 消費するため、呼ぶのはユーザーが一覧でPRを選んだときだけ（ポーリングはしない）。
 */
async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const numberParam = searchParams.get("number");

  if (!owner || !repo || !numberParam || Number.isNaN(Number(numberParam))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const number = Number(numberParam);

  const repository = await db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const [pullRequest, comments, reviews, reviewComments] = await Promise.all([
      fetchPullRequest(owner, repo, number, token),
      // PRの会話コメントはissueコメントと同じエンドポイントで取れる（GitHubではPRもissue）。
      fetchCommentsForIssue(owner, repo, number, token),
      fetchPullRequestReviews(owner, repo, number, token),
      fetchPullRequestReviewComments(owner, repo, number, token),
    ]);

    const detail: PullRequestDetail = {
      id: `${repository.fullName}#${number}`,
      body: pullRequest.body ?? "",
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
      commits: pullRequest.commits,
      mergeable: pullRequest.mergeable,
      events: buildPullRequestEvents({ comments, reviews, reviewComments }),
    };
    return NextResponse.json(detail);
  } catch (error) {
    console.error(`[GET /api/pull-requests/detail] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}
