import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import type { DeployCheckStatus } from "@/types/issue";

const DEPLOY_CHECK_STATUSES: DeployCheckStatus[] = ["ok", "ng", "skip"];

function isDeployCheckStatus(value: unknown): value is DeployCheckStatus {
  return typeof value === "string" && (DEPLOY_CHECK_STATUSES as string[]).includes(value);
}

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
  const status = payload?.status;

  if (typeof issueId !== "string" || !issueId || !isDeployCheckStatus(status)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const issue = await findIssue(userId, issueId);
  if (!issue) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.issueDeployCheck.upsert({
    where: { userId_issueId: { userId, issueId: issue.id } },
    create: { userId, issueId: issue.id, status },
    update: { status },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const issueId = payload?.issueId;

  if (typeof issueId !== "string" || !issueId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const issue = await findIssue(userId, issueId);
  if (!issue) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.issueDeployCheck.deleteMany({ where: { userId, issueId: issue.id } });

  return NextResponse.json({ ok: true });
}
