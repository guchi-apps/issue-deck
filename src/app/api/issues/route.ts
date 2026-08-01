import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { createIssue, updateIssue } from "@/lib/github/issues-api";
import { upsertIssueAndGetDisplay } from "@/lib/github/sync-issues";
import { getIssuesForUser } from "@/lib/issues-for-user";

async function findRepository(userId: string, repositoryFullName: string) {
  return db.repository.findFirst({
    where: {
      fullName: repositoryFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const issues = await getIssuesForUser(userId);
  return NextResponse.json({ issues });
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const repositoryFullName = payload?.repositoryFullName;
  const title = payload?.title;

  if (
    typeof repositoryFullName !== "string" ||
    !repositoryFullName.includes("/") ||
    typeof title !== "string" ||
    !title.trim()
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const [owner, repo] = repositoryFullName.split("/");

  const repository = await findRepository(userId, repositoryFullName);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const created = await createIssue(owner, repo, token, {
      title: title.trim(),
      body: typeof payload.body === "string" && payload.body.trim() ? payload.body : undefined,
      labels: Array.isArray(payload.labels) ? payload.labels.filter((l: unknown) => typeof l === "string") : undefined,
      assignees:
        typeof payload.assignee === "string" && payload.assignee ? [payload.assignee] : undefined,
    });
    const issue = await upsertIssueAndGetDisplay(repository, created);
    return NextResponse.json({ issue });
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
  const repositoryFullName = payload?.repositoryFullName;
  const number = payload?.number;

  if (
    typeof repositoryFullName !== "string" ||
    !repositoryFullName.includes("/") ||
    typeof number !== "number"
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const [owner, repo] = repositoryFullName.split("/");

  const repository = await findRepository(userId, repositoryFullName);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const input: { title?: string; body?: string; state?: "open" | "closed" } = {};
  if (typeof payload.title === "string" && payload.title.trim()) input.title = payload.title.trim();
  if (typeof payload.body === "string") input.body = payload.body;
  if (payload.state === "open" || payload.state === "closed") input.state = payload.state;

  if (Object.keys(input).length === 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const updated = await updateIssue(owner, repo, number, token, input);
    const issue = await upsertIssueAndGetDisplay(repository, updated);
    return NextResponse.json({ issue });
  } catch (error) {
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
