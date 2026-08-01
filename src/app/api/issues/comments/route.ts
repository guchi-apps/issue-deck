import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser, requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { mapComment } from "@/lib/github/issue-mapper";
import {
  createComment,
  deleteComment,
  fetchCommentsForIssue,
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

export async function GET(request: NextRequest) {
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
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
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

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    // GitHub上ではissue-deckのGitHub App(issue-deck[bot])が投稿者になり、実際に
    // 操作した人間が誰かは分からなくなる。ユーザー入力より後ろに投稿者の
    // GitHubログイン名を不可視マーカーとして埋め込むことで、
    // .github/workflows/claude-issue-dispatch.yml 側が実行者のwrite権限を
    // 検証できるようにする(ユーザー本文中に偽のマーカーが含まれていても、
    // 末尾にあるこのマーカーが常に最後に出現するため無効化できる)。
    const bodyWithPoster = `${body.trim()}\n\n<!-- issue-deck:posted-by:${user.githubLogin} -->`;
    const created = await createComment(owner, repo, number, token, { body: bodyWithPoster });
    return NextResponse.json({ comment: mapComment(created) });
  } catch (error) {
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function PATCH(request: NextRequest) {
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
    return NextResponse.json({ comment: mapComment(updated) });
  } catch (error) {
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
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
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
