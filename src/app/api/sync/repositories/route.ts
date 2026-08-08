import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { syncInstallationRepositories } from "@/lib/github/repository-sync";

export function POST() {
  return withGithubApiFeature("repo_sync", () => handlePOST());
}

async function handlePOST() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const installations = await db.githubInstallation.findMany({
    where: { userInstallations: { some: { userId } } },
  });

  // 複数インストールを並列実行するとMariaDBへの書き込みが競合しデッドロックするため、1件ずつ順番に処理する。
  const errors: { installation: string; message: string }[] = [];
  let synced = 0;
  for (const installation of installations) {
    try {
      const installationToken = await getInstallationToken(installation.installationId);
      const repositories = await syncInstallationRepositories(installation, installationToken);
      synced += repositories.length;
    } catch (error) {
      errors.push({
        installation: installation.accountLogin,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({ synced, errors });
}
