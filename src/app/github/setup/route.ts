import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getAppJwt, getInstallationToken } from "@/lib/github/app-auth";
import { fetchInstallation } from "@/lib/github/installations-api";
import { syncInstallationRepositories } from "@/lib/github/repository-sync";
import { syncRepositoryIssues } from "@/lib/github/sync-issues";
import { getRequestOrigin } from "@/lib/request-origin";
import type { AccountType, RepositorySelection } from "@prisma/client";

function toAccountType(githubType: string): AccountType {
  return githubType === "Organization" ? "ORGANIZATION" : "USER";
}

function toRepositorySelection(value: "all" | "selected"): RepositorySelection {
  return value === "all" ? "ALL" : "SELECTED";
}

export function GET(request: NextRequest) {
  return withGithubApiFeature("setup", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const origin = getRequestOrigin(request);
  const { searchParams } = new URL(request.url);
  const installationIdParam = searchParams.get("installation_id");
  const setupAction = searchParams.get("setup_action");

  if (setupAction === "request") {
    return NextResponse.redirect(`${origin}/github/setup/pending`);
  }

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

  const savedRepositories = await syncInstallationRepositories(githubInstallation, installationToken);

  await db.userInstallation.upsert({
    where: { userId_installationId: { userId, installationId: githubInstallation.id } },
    create: { userId, installationId: githubInstallation.id },
    update: {},
  });

  // Issueキャッシュも同期する（インストール直後・リポジトリ選択変更直後に反映されるように）。
  // 全リポジトリを並列実行するとMariaDBへの書き込みが競合しデッドロックするため、1件ずつ順番に処理する。
  for (const repo of savedRepositories) {
    try {
      await syncRepositoryIssues({
        id: repo.id,
        ownerLogin: repo.ownerLogin,
        name: repo.name,
        installation: { installationId },
      });
    } catch (error) {
      console.error(`[github/setup] failed to sync issues for ${repo.fullName}`, error);
    }
  }

  return NextResponse.redirect(`${origin}/dashboard`);
}
