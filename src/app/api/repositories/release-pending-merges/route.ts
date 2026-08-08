import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchOpenPullRequestsForBase } from "@/lib/github/release-api";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";

export type ReleasePendingMerge = {
  repoFullName: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestTitle: string;
};

export function GET() {
  return withGithubApiFeature("release_pending_merges", handleGET);
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 選択肢に出せる（=リリースworkflow導入済みの）リポジトリと同じ条件で全件対象にする。
  const repositories = await db.repository.findMany({
    where: {
      hasClaudeWorkflow: true,
      installation: { userInstallations: { some: { userId } } },
    },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });

  if (repositories.length === 0) {
    return NextResponse.json({ pendingMerges: [] });
  }

  // 同一installationのリポジトリ間でトークン取得を使い回し、無駄なAPI呼び出しを避ける。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const results = await Promise.all(
    repositories.map(async (repository): Promise<ReleasePendingMerge | null> => {
      try {
        const token = await tokenFor(repository.installation.installationId);
        const available = await releaseWorkflowExists(repository.ownerLogin, repository.name, token);
        if (!available) return null;

        const pullRequests = await fetchOpenPullRequestsForBase(
          repository.ownerLogin,
          repository.name,
          "main",
          token,
        );
        const releasePr = pullRequests.find((pr) => pr.head.ref === "develop");
        if (!releasePr) return null;

        return {
          repoFullName: repository.fullName,
          pullRequestNumber: releasePr.number,
          pullRequestUrl: releasePr.html_url,
          pullRequestTitle: releasePr.title,
        };
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの表示まで巻き込まないよう、ログのみ残してスキップする。
        console.error(
          `[GET /api/repositories/release-pending-merges] ${repository.fullName}:`,
          error,
        );
        return null;
      }
    }),
  );

  return NextResponse.json({
    pendingMerges: results.filter((result): result is ReleasePendingMerge => result !== null),
  });
}
