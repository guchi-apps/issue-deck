import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth-user";
import { getAppJwt, getInstallationToken } from "@/lib/github/app-auth";
import { getRequestOrigin } from "@/lib/request-origin";
import type { AccountType, RepositorySelection } from "@prisma/client";

const GITHUB_API = "https://api.github.com";

type GithubInstallationResponse = {
  id: number;
  account: { id: number; login: string; type: string } | null;
  repository_selection: "all" | "selected";
  suspended_at: string | null;
};

type GithubRepositoryResponse = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  archived: boolean;
  default_branch: string;
  owner: { login: string };
};

function toAccountType(githubType: string): AccountType {
  return githubType === "Organization" ? "ORGANIZATION" : "USER";
}

function toRepositorySelection(value: "all" | "selected"): RepositorySelection {
  return value === "all" ? "ALL" : "SELECTED";
}

async function fetchInstallation(
  installationId: number,
  jwt: string,
): Promise<GithubInstallationResponse> {
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch installation: ${res.status}`);
  }
  return res.json();
}

async function fetchInstallationRepositories(
  installationToken: string,
): Promise<GithubRepositoryResponse[]> {
  const repositories: GithubRepositoryResponse[] = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${installationToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch installation repositories: ${res.status}`);
    }
    const data: { repositories: GithubRepositoryResponse[] } = await res.json();
    repositories.push(...data.repositories);

    if (data.repositories.length < 100) break;
    page += 1;
  }

  return repositories;
}

export async function GET(request: NextRequest) {
  const origin = getRequestOrigin(request);
  const { searchParams } = new URL(request.url);
  const installationIdParam = searchParams.get("installation_id");

  if (!installationIdParam) {
    return NextResponse.redirect(`${origin}/dashboard`);
  }
  const installationId = Number(installationIdParam);

  const userId = await requireUserId();
  if (!userId) {
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("callbackUrl", `/github/setup?${searchParams.toString()}`);
    return NextResponse.redirect(loginUrl);
  }

  const [appJwt, installationToken] = await Promise.all([
    getAppJwt(),
    getInstallationToken(installationId),
  ]);

  const installation = await fetchInstallation(installationId, appJwt);
  const repositories = await fetchInstallationRepositories(installationToken);

  const githubInstallation = await db.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      accountId: installation.account?.id ?? 0,
      accountLogin: installation.account?.login ?? "",
      accountType: toAccountType(installation.account?.type ?? "User"),
      repositorySelection: toRepositorySelection(installation.repository_selection),
      suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
    },
    update: {
      accountId: installation.account?.id ?? 0,
      accountLogin: installation.account?.login ?? "",
      accountType: toAccountType(installation.account?.type ?? "User"),
      repositorySelection: toRepositorySelection(installation.repository_selection),
      suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
    },
  });

  await db.$transaction([
    ...repositories.map((repo) =>
      db.repository.upsert({
        where: { githubRepositoryId: repo.id },
        create: {
          githubRepositoryId: repo.id,
          installationId: githubInstallation.id,
          ownerLogin: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          htmlUrl: repo.html_url,
          archived: repo.archived,
          defaultBranch: repo.default_branch,
          lastSyncedAt: new Date(),
        },
        update: {
          ownerLogin: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          htmlUrl: repo.html_url,
          archived: repo.archived,
          defaultBranch: repo.default_branch,
          lastSyncedAt: new Date(),
        },
      }),
    ),
    db.repository.deleteMany({
      where: {
        installationId: githubInstallation.id,
        githubRepositoryId: { notIn: repositories.map((repo) => repo.id) },
      },
    }),
  ]);

  await db.userInstallation.upsert({
    where: { userId_installationId: { userId, installationId: githubInstallation.id } },
    create: { userId, installationId: githubInstallation.id },
    update: {},
  });

  return NextResponse.redirect(`${origin}/dashboard`);
}
