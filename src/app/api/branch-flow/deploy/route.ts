import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { deployWorkflowExists } from "@/lib/github/deploy-workflow-cache";
import { fetchLatestDeployWorkflowRun } from "@/lib/github/release-api";
import type { BranchFlowDeployResponse, RepositoryDeployStatus } from "@/types/branch-flow";

export function GET() {
  return withGithubApiFeature("deploy_status", () => handleGET());
}

/**
 * リポジトリ横断の本番デプロイ状況を返す（#1579）。
 *
 * 「ブランチとPRの流れ」画面は、develop→mainのPRがマージされた瞬間に「◯/◯に本番反映」と
 * 出していた。**マージは本番反映ではない**——そこから`deploy.yml`が数分走り、失敗すればmainに
 * 入ったまま本番へは出ない。それをPRの情報だけからは言えないため、mainブランチの`deploy.yml`の
 * 最新実行だけをここで取りに行く。
 *
 * `/api/branch-flow`（ブランチ状況）と分けているのは、**デプロイ中だけ短い間隔で取り直す**ため
 * （`hooks/use-deploy-status.ts`）。あちらはリポジトリあたりGraphQL 1回で、同じ間隔で回すと
 * 消費が釣り合わない。こちらの消費はリポジトリあたりREST 1回で、しかもETagの条件付きGETを
 * 通しているため、実行が進んでいない間の再取得はレート制限を消費しない。
 *
 * 対象は`/api/branch-flow`と同じ母集団のうち、**`deploy.yml`を持つリポジトリだけ**。
 * 元はリリース用workflowの有無で絞っていたが（状態を出す先がリリースの束しか無かったため）、
 * #2020で「本番へ再デプロイ」を足したことで、リリースの束が無くても状態を出す先ができた
 * （押している最中にボタンを押させないための材料と、畳んだ1行の「デプロイ中」）。
 * **ボタンを出す条件（`hasDeployWorkflow`）と同じ条件で絞る**——片方だけ`deploy.yml`を持つ
 * リポジトリが現れた瞬間に「押せるのに進捗が出ない」が起こるため。
 */
async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const hiddenRepositoryIds = (
    await db.hiddenRepository.findMany({ where: { userId }, select: { repositoryId: true } })
  ).map((row) => row.repositoryId);

  const repositories = await db.repository.findMany({
    where: {
      archived: false,
      id: { notIn: hiddenRepositoryIds },
      installation: { userInstallations: { some: { userId } } },
    },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });

  // 同一installationのリポジトリ間でトークン取得を使い回す（`/api/branch-flow`と同じ方針）。
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
    repositories.map(async (repository): Promise<RepositoryDeployStatus | null> => {
      try {
        const token = await tokenFor(repository.installation.installationId);
        // プロセス内に10分キャッシュされ、ブランチ状況・デプロイの起動と共有される（#2020）
        const hasDeployWorkflow = await deployWorkflowExists(
          repository.ownerLogin,
          repository.name,
          token,
        );
        if (!hasDeployWorkflow) return null;

        const deployRun = await fetchLatestDeployWorkflowRun(
          repository.ownerLogin,
          repository.name,
          token,
        );
        if (deployRun === null) return null;

        return { repositoryFullName: repository.fullName, deployRun };
      } catch (error) {
        // 1リポジトリの取得失敗で画面全体を落とさない。返さなければ従来どおりの表示になる。
        console.error(`[GET /api/branch-flow/deploy] ${repository.fullName}:`, error);
        return null;
      }
    }),
  );

  const response: BranchFlowDeployResponse = {
    repositories: results.filter((result) => result !== null),
    fetchedAt: new Date().toISOString(),
  };
  return NextResponse.json(response);
}
