import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

async function findIssue(userId: string, issueId: string) {
  let githubIssueId: bigint;
  try {
    githubIssueId = BigInt(issueId);
  } catch {
    return null;
  }

  return db.issue.findFirst({
    where: {
      githubIssueId,
      repository: { installation: { userInstallations: { some: { userId } } } },
    },
  });
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const issueId = payload?.issueId;
  const readCommentCount = payload?.readCommentCount;

  if (
    typeof issueId !== "string" ||
    !issueId ||
    typeof readCommentCount !== "number" ||
    !Number.isInteger(readCommentCount) ||
    readCommentCount < 0
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const issue = await findIssue(userId, issueId);
  if (!issue) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.issueCommentRead.upsert({
    where: { userId_issueId: { userId, issueId: issue.id } },
    create: { userId, issueId: issue.id, readCommentCount },
    update: { readCommentCount },
  });

  return NextResponse.json({ ok: true });
}
