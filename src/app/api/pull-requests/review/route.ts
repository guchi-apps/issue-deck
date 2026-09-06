import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchCommentsForIssue } from "@/lib/github/issues-api";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { selectPullRequestReviewComment } from "@/lib/github/pull-request-review-comment";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";

export function GET(request: NextRequest) {
  return withGithubApiFeature("pull_request_review_comment", () => handleGET(request));
}

/**
 * develop向けPRへ投稿された自動レビューのコメント本体を1件返す（#2849）。
 *
 * **呼ぶのはマージ待ちの承認カードを出すときだけ。** 1回で2リクエスト（PR本体＋会話コメント）
 * を消費するため、Issueを開いているだけの間や、ポーリングでは取りに行かない
 * （`useIssuePullRequests`が20秒ごとに取る一覧へ相乗りさせない。あちらは全PRぶんの応答が
 * 膨らむうえ、レビューの本文は判定と違って画面の上部では使わない）。
 *
 * **同じ材料を返す`/api/pull-requests/detail`を使い回さないのは、消費が倍以上違うため。**
 * あちらはPR本体・会話コメント・レビュー・レビューコメントで1回4〜5リクエストを使い、
 * 画面が要らない差分統計・イベントの時系列まで組み立てる。ここで欲しいのはレビューコメント1件
 * だけなので、必要な2つに絞る。
 *
 * **PR本体を取るのはhead SHAのため。** 追いコミットの後に古いレビューを「いまの判定」として
 * 出さないよう、コメントの`sha=`と突き合わせる（判定が食い違うときの扱いは
 * `selectPullRequestReviewComment`）。
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
    const [pullRequest, comments] = await Promise.all([
      fetchPullRequest(owner, repo, number, token),
      fetchCommentsForIssue(owner, repo, number, token),
    ]);

    const review = selectPullRequestReviewComment(
      comments.map((comment) => ({
        body: comment.body,
        createdAt: comment.created_at,
        htmlUrl: comment.html_url ?? null,
      })),
      pullRequest.head.sha,
    );

    return NextResponse.json({ review });
  } catch (error) {
    console.error(`[GET /api/pull-requests/review] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}
