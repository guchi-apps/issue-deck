import { describeGithubError } from "@/lib/github/forbidden-cause";
import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchIosReleaseStatus } from "@/lib/github/ios-release-status";
import { fetchReleasesBackTo } from "@/lib/github/release-api";
import { hasReachedReleaseCheckSince } from "@/lib/release-check";
import type { IosReleaseStatus } from "@/lib/release-history";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";

export function GET() {
  return withGithubApiFeature("release_history", handleGET);
}

/**
 * リリース履歴のiOS配布バッジの材料（#5214）。`api/repositories/release-history`の後に呼ばれる。
 *
 * 版の範囲を一覧と揃えるためReleaseを同じ条件で引き直すが、一覧が取った直後なのでETagで
 * レート制限を消費しない。取れなかったリポジトリは`failedRepositories`で返し、画面が案内を出す。
 */
async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const allRepositories = await db.repository.findMany({
    where: {
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });
  const repositories = allRepositories.filter((repository) => getWebviewIosRepository(repository.fullName) !== null);
  if (repositories.length === 0) {
    return NextResponse.json({ statuses: [], failedRepositories: [] });
  }

  const checkTargetRows = await db.releaseCheckTarget.findMany({
    where: { userId, repositoryId: { in: repositories.map((repository) => repository.id) } },
    select: { createdAt: true, repositoryId: true },
  });
  const sinceMsByRepositoryId = new Map(checkTargetRows.map((row) => [row.repositoryId, row.createdAt.getTime()]));

  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const failedRepositories: string[] = [];
  const failedReasons: Record<string, string> = {};
  const results = await Promise.all(
    repositories.map(async (repository): Promise<IosReleaseStatus | null> => {
      try {
        const token = await tokenFor(repository.installation.installationId);
        const releases = await fetchReleasesBackTo(
          repository.ownerLogin,
          repository.name,
          token,
          sinceMsByRepositoryId.get(repository.id),
          hasReachedReleaseCheckSince,
        );
        if (releases.length === 0) return null;
        return await fetchIosReleaseStatus(
          repository.ownerLogin,
          repository.name,
          token,
          releases.map((release) => release.tagName),
        );
      } catch (error) {
        console.error(`[GET /api/repositories/release-history/ios-status] ${repository.fullName}:`, error);
        failedRepositories.push(repository.fullName);
        const reason = describeGithubError(error);
        if (reason) failedReasons[repository.fullName] = reason;
        return null;
      }
    }),
  );

  return NextResponse.json({
    statuses: results.filter((status): status is IosReleaseStatus => status !== null),
    failedRepositories,
    failedReasons,
  });
}
