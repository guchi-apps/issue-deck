import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchOpenPullRequestsForBase, fetchRefCiState } from "@/lib/github/release-api";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";

/** "main": develop→mainのPRがマージ待ち。"develop": バンプPRがCI通過後もマージ待ち（#979） */
export type ReleaseMergeTarget = "main" | "develop";

export type ReleasePendingMerge = {
  repoFullName: string;
  mergeTarget: ReleaseMergeTarget;
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

        const [developBasePullRequests, mainBasePullRequests] = await Promise.all([
          fetchOpenPullRequestsForBase(repository.ownerLogin, repository.name, "develop", token),
          fetchOpenPullRequestsForBase(repository.ownerLogin, repository.name, "main", token),
        ]);

        // mainへのマージ待ち（develop→mainのPRがオープン中）を最優先で検出する。
        const releasePr = mainBasePullRequests.find((pr) => pr.head.ref === "develop");
        if (releasePr) {
          return {
            repoFullName: repository.fullName,
            mergeTarget: "main",
            pullRequestNumber: releasePr.number,
            pullRequestUrl: releasePr.html_url,
            pullRequestTitle: releasePr.title,
          };
        }

        // developへのマージ待ち（バンプPRがCI通過後も残っている＝auto-merge滞留）を検出する。
        // `summarizeReleaseButtonStatus`のaction_required判定基準（CIがpendingでなくなった時点）と揃える。
        const bumpPr = developBasePullRequests.find((pr) => pr.head.ref.startsWith("release/v"));
        if (bumpPr) {
          const ciState = await fetchRefCiState(repository.ownerLogin, repository.name, bumpPr.head.ref, token);
          if (ciState !== "pending") {
            return {
              repoFullName: repository.fullName,
              mergeTarget: "develop",
              pullRequestNumber: bumpPr.number,
              pullRequestUrl: bumpPr.html_url,
              pullRequestTitle: bumpPr.title,
            };
          }
        }

        return null;
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
