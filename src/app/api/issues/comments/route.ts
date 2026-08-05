import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser, requireUserId } from "@/lib/auth-user";
import { decryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { mapComment } from "@/lib/github/issue-mapper";
import {
  createComment,
  deleteComment,
  fetchCommentsForIssue,
  GithubApiError,
  updateComment,
} from "@/lib/github/issues-api";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

export function GET(request: NextRequest) {
  return withGithubApiFeature("issue_comments", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const numberParam = searchParams.get("number");

  if (!owner || !repo || !numberParam) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const rawComments = await fetchCommentsForIssue(owner, repo, Number(numberParam), token);
    return NextResponse.json({ comments: rawComments.map(mapComment) });
  } catch (error) {
    console.error(`[GET /api/issues/comments] ${owner}/${repo}#${numberParam}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export function POST(request: NextRequest) {
  return withGithubApiFeature("comment_write", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const number = payload?.number;
  const body = payload?.body;

  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof number !== "number" ||
    typeof body !== "string" ||
    !body.trim()
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(user.id, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (!user.githubAccessToken) {
    return NextResponse.json({ error: "github_reauth_required" }, { status: 409 });
  }

  try {
    const token = decryptSecret(user.githubAccessToken);
    const created = await createComment(owner, repo, number, token, { body: body.trim() });
    return NextResponse.json({ comment: mapComment(created) });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 401) {
      await db.user.update({ where: { id: user.id }, data: { githubAccessToken: null } });
      return NextResponse.json({ error: "github_reauth_required" }, { status: 409 });
    }
    console.error(`[POST /api/issues/comments] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export function PATCH(request: NextRequest) {
  return withGithubApiFeature("comment_write", () => handlePATCH(request));
}

async function handlePATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const commentId = payload?.commentId;
  const body = payload?.body;

  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof commentId !== "number" ||
    typeof body !== "string" ||
    !body.trim()
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const updated = await updateComment(owner, repo, commentId, token, { body: body.trim() });
    // 編集によって内容が変わった以上、キャッシュ済みのAI要約は古くなるため削除する（再生成はボタン操作に委ねる）
    await db.issueCommentSummary.deleteMany({ where: { githubCommentId: BigInt(commentId) } });
    return NextResponse.json({ comment: mapComment(updated) });
  } catch (error) {
    console.error(`[PATCH /api/issues/comments] ${owner}/${repo} comment ${commentId}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export function DELETE(request: NextRequest) {
  return withGithubApiFeature("comment_write", () => handleDELETE(request));
}

async function handleDELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const commentIdParam = searchParams.get("commentId");

  if (!owner || !repo || !commentIdParam || Number.isNaN(Number(commentIdParam))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    await deleteComment(owner, repo, Number(commentIdParam), token);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(`[DELETE /api/issues/comments] ${owner}/${repo} comment ${commentIdParam}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
