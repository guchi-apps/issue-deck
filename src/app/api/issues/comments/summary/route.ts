import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { generateCommentSummary } from "@/lib/claude/comment-summary";
import { getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchComment } from "@/lib/github/issues-api";

async function findIssue(userId: string, owner: string, repo: string, number: number) {
  const repository = await db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
  if (!repository) return null;

  const issue = await db.issue.findFirst({ where: { repositoryId: repository.id, number } });
  if (!issue) return null;

  return { repository, issue };
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

  const found = await findIssue(userId, owner, repo, Number(numberParam));
  if (!found) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const rows = await db.issueCommentSummary.findMany({ where: { issueId: found.issue.id } });
  return NextResponse.json({
    summaries: rows.map((row) => ({
      commentId: row.githubCommentId.toString(),
      summary: row.summary,
      generatedAt: row.generatedAt,
    })),
  });
}

export function POST(request: NextRequest) {
  return withGithubApiFeature("issue_comments", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await getAppAiToken("comment_summary");
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const number = payload?.number;
  const commentId = payload?.commentId;

  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof number !== "number" ||
    typeof commentId !== "number"
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const found = await findIssue(userId, owner, repo, number);
  if (!found) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { repository, issue } = found;

  try {
    const githubToken = await getInstallationToken(repository.installation.installationId);
    const rawComment = await fetchComment(owner, repo, commentId, githubToken);

    const summary = await generateCommentSummary(token, rawComment.body ?? "");
    const generatedAt = new Date();

    await db.issueCommentSummary.upsert({
      where: { issueId_githubCommentId: { issueId: issue.id, githubCommentId: BigInt(commentId) } },
      create: { issueId: issue.id, githubCommentId: BigInt(commentId), summary, generatedAt },
      update: { summary, generatedAt },
    });

    return NextResponse.json({ commentId: String(commentId), summary, generatedAt });
  } catch (error) {
    console.error(
      `[POST /api/issues/comments/summary] ${owner}/${repo}#${number} comment ${commentId}:`,
      error,
    );
    return NextResponse.json(
      { error: "summary_generation_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
