import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { updatePullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { createComment, fetchCommentsForIssue, GithubApiError } from "@/lib/github/issues-api";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { selectPullRequestReviewComment } from "@/lib/github/pull-request-review-comment";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import {
  applyAcknowledgementToReleaseBody,
  buildAckComment,
  buildRevokeComment,
  currentAcknowledgement,
  type AcknowledgeableVerdict,
} from "@/lib/github/review-acknowledgement";
import { previewModeGuard } from "@/lib/preview-mode";

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_review_ack", () => handlePOST(request));
}

/**
 * 自動レビューの指摘を「確認済み・対応しない」と記録する／取り消す（#3739）。
 *
 * - develop向けPRへ、記録のマーカー付きコメントを投稿する（`review-acknowledgement.ts`）
 * - `releasePullRequestNumber`があれば、開いているリリースPR本文の該当行も書き換える。
 *   リリースPR本文の検証結果は作成時に1回書かれるだけで、画面もマージ確認もそこを読むため、
 *   書き換えないと「押しても変わらない」ことになる
 *
 * **コメントは必ずinstallationトークン（App bot）で投稿する。** 読む側（リリースのワークフロー・
 * 画面）はApp botが投稿したコメントだけを記録として採用する。ユーザー本人のトークンで投稿すると
 * 採用されず、PUBLICリポジトリで第三者が同じマーカーを書くのを防ぐ前提も崩れる。
 *
 * 記録できるのは、いまのレビューの判定が要確認・要修正のときだけ。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload: {
    owner?: unknown;
    repo?: unknown;
    number?: unknown;
    issueNumber?: unknown;
    action?: unknown;
    reason?: unknown;
    releasePullRequestNumber?: unknown;
  } = await request.json().catch(() => ({}));
  const { owner, repo, number, issueNumber, action, reason, releasePullRequestNumber } = payload;

  const isPositiveInt = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value > 0;
  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo ||
    !isPositiveInt(number) ||
    (action !== "acknowledge" && action !== "revoke") ||
    (issueNumber !== undefined && !isPositiveInt(issueNumber)) ||
    (releasePullRequestNumber !== undefined && !isPositiveInt(releasePullRequestNumber)) ||
    (reason !== undefined && typeof reason !== "string") ||
    (releasePullRequestNumber !== undefined && issueNumber === undefined)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const [repository, user] = await Promise.all([
    db.repository.findFirst({
      where: {
        fullName: `${owner}/${repo}`,
        installation: { userInstallations: { some: { userId } } },
      },
      include: { installation: true },
    }),
    db.user.findUnique({ where: { id: userId }, select: { githubLogin: true } }),
  ]);
  if (!repository || !user) {
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
    if (!review?.reviewedSha) {
      return NextResponse.json({ error: "no_review" }, { status: 409 });
    }
    const verdict = review.verdictKind;
    if (action === "acknowledge" && verdict !== "needs-check" && verdict !== "changes-requested") {
      // 問題なし・実施なし・判定不明に「対応しない」は要らない
      return NextResponse.json({ error: "not_acknowledgeable" }, { status: 409 });
    }

    const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
    const existing = currentAcknowledgement(
      comments.map((comment) => ({
        body: comment.body,
        author: { login: comment.user?.login ?? "", type: comment.user?.type },
      })),
      review.reviewedSha,
      slug,
    );

    // 取り消しの対象が元の判定を持たない（記録が無い）ときも、リリースPR側の書き換えは行うので
    // コメントだけは重複させない
    if (action === "acknowledge" && !existing) {
      await createComment(owner, repo, number, token, {
        body: buildAckComment({
          sha: review.reviewedSha,
          recordedBy: user.githubLogin,
          verdict: verdict as AcknowledgeableVerdict,
          reason: typeof reason === "string" ? reason : "",
        }),
      });
    }
    if (action === "revoke" && existing) {
      await createComment(owner, repo, number, token, {
        body: buildRevokeComment({ sha: review.reviewedSha, revokedBy: user.githubLogin }),
      });
    }

    let releaseUpdated = false;
    if (releasePullRequestNumber !== undefined && issueNumber !== undefined) {
      const release = await fetchPullRequest(owner, repo, releasePullRequestNumber, token);
      const nextBody = applyAcknowledgementToReleaseBody(
        release.body ?? "",
        issueNumber,
        action === "acknowledge"
          ? { type: "acknowledge", verdict: verdict as AcknowledgeableVerdict, recordedBy: user.githubLogin }
          : { type: "revoke" },
      );
      if (nextBody !== null) {
        await updatePullRequest(owner, repo, releasePullRequestNumber, { title: release.title, body: nextBody }, token);
        releaseUpdated = true;
      }
    }

    return NextResponse.json({ ok: true, releaseUpdated });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error(`[POST /api/pull-requests/review-ack] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}
