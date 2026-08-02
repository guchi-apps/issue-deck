import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { decryptSecret } from "@/lib/crypto/secret-cipher";
import { db } from "@/lib/db";
import { GithubApiError } from "@/lib/github/issues-api";
import {
  dispatchReleaseWorkflow,
  fetchOpenPullRequestsForBase,
  fetchPackageVersion,
  fetchReleaseWorkflowExists,
} from "@/lib/github/release-api";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
  });
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");

  if (!owner || !repo) {
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
    const available = await fetchReleaseWorkflowExists(owner, repo, token);
    if (!available) {
      return NextResponse.json({ available: false });
    }

    const [mainVersion, developVersion, developBasePullRequests, mainBasePullRequests] =
      await Promise.all([
        fetchPackageVersion(owner, repo, "main", token),
        fetchPackageVersion(owner, repo, "develop", token),
        fetchOpenPullRequestsForBase(owner, repo, "develop", token),
        fetchOpenPullRequestsForBase(owner, repo, "main", token),
      ]);

    const bumpPr = developBasePullRequests.find((pr) => pr.head.ref.startsWith("release/v")) ?? null;
    const releasePr = mainBasePullRequests.find((pr) => pr.head.ref === "develop") ?? null;

    return NextResponse.json({
      available: true,
      mainVersion,
      developVersion,
      bumpPullRequest: bumpPr
        ? { number: bumpPr.number, url: bumpPr.html_url, title: bumpPr.title }
        : null,
      releasePullRequest: releasePr
        ? { number: releasePr.number, url: releasePr.html_url, title: releasePr.title }
        : null,
    });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 401) {
      await db.user.update({ where: { id: user.id }, data: { githubAccessToken: null } });
      return NextResponse.json({ error: "github_reauth_required" }, { status: 409 });
    }
    console.error(`[GET /api/repositories/release] ${owner}/${repo}:`, error);
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

  if (typeof owner !== "string" || typeof repo !== "string") {
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
    await dispatchReleaseWorkflow(owner, repo, token);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 401) {
      await db.user.update({ where: { id: user.id }, data: { githubAccessToken: null } });
      return NextResponse.json({ error: "github_reauth_required" }, { status: 409 });
    }
    console.error(`[POST /api/repositories/release] ${owner}/${repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
