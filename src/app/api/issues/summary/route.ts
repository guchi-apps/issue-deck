import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { generateIssueSummary } from "@/lib/claude/issue-summary";
import { getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchCommentsForIssue } from "@/lib/github/issues-api";

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

  const { issue } = found;
  return NextResponse.json({
    summary: issue.aiSummary,
    generatedAt: issue.aiSummaryGeneratedAt,
    commentCountAtGeneration: issue.aiSummaryCommentCount,
    currentCommentCount: issue.commentCount,
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

  const token = await getAppAiToken();
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const number = payload?.number;

  if (typeof owner !== "string" || typeof repo !== "string" || typeof number !== "number") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const found = await findIssue(userId, owner, repo, number);
  if (!found) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { repository, issue } = found;

  try {
    const githubToken = await getInstallationToken(repository.installation.installationId);
    const rawComments = await fetchCommentsForIssue(owner, repo, number, githubToken);

    const summary = await generateIssueSummary(token, {
      title: issue.title,
      body: issue.body ?? "",
      comments: rawComments.map((comment) => ({
        author: comment.user?.login ?? "unknown",
        body: comment.body ?? "",
      })),
    });

    const updated = await db.issue.update({
      where: { id: issue.id },
      data: {
        aiSummary: summary,
        aiSummaryCommentCount: rawComments.length,
        aiSummaryGeneratedAt: new Date(),
      },
    });

    return NextResponse.json({
      summary: updated.aiSummary,
      generatedAt: updated.aiSummaryGeneratedAt,
      commentCountAtGeneration: updated.aiSummaryCommentCount,
      currentCommentCount: updated.commentCount,
    });
  } catch (error) {
    console.error(`[POST /api/issues/summary] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "summary_generation_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
