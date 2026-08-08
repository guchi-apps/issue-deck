import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser, requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { createIssue, deleteIssue, updateIssue } from "@/lib/github/issues-api";
import { upsertIssueAndGetDisplay } from "@/lib/github/sync-issues";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
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

export function POST(request: NextRequest) {
  return withGithubApiFeature("issue_write", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
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

  const repository = await findRepository(user.id, repositoryFullName);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await withUserGithubToken(user, `POST /api/issues ${repositoryFullName}`, async (token) => {
    const created = await createIssue(owner, repo, token, {
      title: title.trim(),
      body: typeof payload.body === "string" && payload.body.trim() ? payload.body : undefined,
      labels: Array.isArray(payload.labels) ? payload.labels.filter((l: unknown) => typeof l === "string") : undefined,
      assignees:
        typeof payload.assignee === "string" && payload.assignee ? [payload.assignee] : undefined,
    });
    return upsertIssueAndGetDisplay(repository, created);
  });
  if ("errorResponse" in result) {
    return result.errorResponse;
  }
  return NextResponse.json({ issue: result.value });
}

export function PATCH(request: NextRequest) {
  return withGithubApiFeature("issue_write", () => handlePATCH(request));
}

async function handlePATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
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

  const repository = await findRepository(user.id, repositoryFullName);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const input: {
    title?: string;
    body?: string;
    state?: "open" | "closed";
    state_reason?: "completed" | "not_planned";
    labels?: string[];
    assignees?: string[];
  } = {};
  if (typeof payload.title === "string" && payload.title.trim()) input.title = payload.title.trim();
  if (typeof payload.body === "string") input.body = payload.body;
  if (payload.state === "open" || payload.state === "closed") input.state = payload.state;
  if (payload.stateReason === "completed" || payload.stateReason === "not_planned") {
    input.state_reason = payload.stateReason;
  }
  if (Array.isArray(payload.labels)) {
    input.labels = payload.labels.filter((l: unknown) => typeof l === "string");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "assignee")) {
    if (payload.assignee === null) input.assignees = [];
    else if (typeof payload.assignee === "string" && payload.assignee) input.assignees = [payload.assignee];
  }

  if (Object.keys(input).length === 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await withUserGithubToken(
    user,
    `PATCH /api/issues ${repositoryFullName}#${number}`,
    async (token) => {
      const updated = await updateIssue(owner, repo, number, token, input);
      return upsertIssueAndGetDisplay(repository, updated);
    },
  );
  if ("errorResponse" in result) {
    return result.errorResponse;
  }
  return NextResponse.json({ issue: result.value });
}

export function DELETE(request: NextRequest) {
  return withGithubApiFeature("issue_write", () => handleDELETE(request));
}

async function handleDELETE(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const repositoryFullName = searchParams.get("repositoryFullName");
  const numberParam = searchParams.get("number");

  if (!repositoryFullName || !repositoryFullName.includes("/") || !numberParam || Number.isNaN(Number(numberParam))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const number = Number(numberParam);

  const [owner, repo] = repositoryFullName.split("/");

  const repository = await findRepository(user.id, repositoryFullName);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await withUserGithubToken(
    user,
    `DELETE /api/issues ${repositoryFullName}#${number}`,
    async (token) => {
      await deleteIssue(owner, repo, number, token);
      await db.issue.deleteMany({ where: { repositoryId: repository.id, number } });
    },
  );
  if ("errorResponse" in result) {
    return result.errorResponse;
  }
  return NextResponse.json({ success: true });
}
