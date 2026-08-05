import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { decryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { GithubApiError, transferIssue } from "@/lib/github/issues-api";
import { upsertIssueAndGetDisplay } from "@/lib/github/sync-issues";

async function findRepository(userId: string, repositoryFullName: string) {
  return db.repository.findFirst({
    where: {
      fullName: repositoryFullName,
      installation: { userInstallations: { some: { userId } } },
    },
  });
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
  const number = payload?.number;
  const newRepositoryFullName = payload?.newRepositoryFullName;

  if (
    typeof repositoryFullName !== "string" ||
    !repositoryFullName.includes("/") ||
    typeof number !== "number" ||
    typeof newRepositoryFullName !== "string" ||
    !newRepositoryFullName.includes("/") ||
    newRepositoryFullName === repositoryFullName
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const [owner, repo] = repositoryFullName.split("/");
  const [newOwner, newRepo] = newRepositoryFullName.split("/");

  const [repository, destinationRepository] = await Promise.all([
    findRepository(user.id, repositoryFullName),
    findRepository(user.id, newRepositoryFullName),
  ]);
  if (!repository || !destinationRepository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (!user.githubAccessToken) {
    return NextResponse.json({ error: "github_reauth_required" }, { status: 409 });
  }

  try {
    const token = decryptSecret(user.githubAccessToken);
    const transferred = await transferIssue(owner, repo, number, newOwner, newRepo, token);
    const issue = await upsertIssueAndGetDisplay(destinationRepository, transferred);
    return NextResponse.json({ issue });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 401) {
      await db.user.update({ where: { id: user.id }, data: { githubAccessToken: null } });
      return NextResponse.json({ error: "github_reauth_required" }, { status: 409 });
    }
    console.error(
      `[POST /api/issues/transfer] ${repositoryFullName}#${number} -> ${newRepositoryFullName}:`,
      error,
    );
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
