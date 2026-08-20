import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { deployWorkflowExists } from "@/lib/github/deploy-workflow-cache";
import { GithubApiError } from "@/lib/github/github-api-error";
import { dispatchDeployWorkflow } from "@/lib/github/release-api";
import { previewModeGuard } from "@/lib/preview-mode";

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("deploy_dispatch", () => handlePOST(request));
}

/**
 * 本番デプロイworkflow（`deploy.yml`）をmainに対して手動起動する（#2020）。
 *
 * **マージするものが無くても本番へ出し直せるようにするための口。** これまで本番へ反映する
 * 手段はdevelop→mainのマージだけで、GitHubのSecretsや環境変数を変えただけのとき
 * （`deploy.yml`が本番の`.env`をまるごと書き直す）も、出すコードが無いのにリリースを
 * 1回まわす必要があった。
 *
 * 起動するだけで、進み具合は追わない。mainの`deploy.yml`の最新実行は
 * `/api/branch-flow/deploy`が既に見ており、そちらが「デプロイ中」「デプロイ成功」を出す。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;

  if (typeof owner !== "string" || typeof repo !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    // 起動前にworkflowの有無を確かめる（リリースの起動と同じ理由。#1538）。無いリポジトリで
    // dispatchすると、GitHubの生の404本文がそのまま画面へ出て何が足りないのか読み取れない。
    // 判定はブランチ画面と同じキャッシュを通るので追加の消費はほぼ無い。
    if (!(await deployWorkflowExists(owner, repo, token))) {
      return NextResponse.json({ error: "deploy_workflow_missing" }, { status: 400 });
    }

    await dispatchDeployWorkflow(owner, repo, token);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // `deploy.yml`はあるが`workflow_dispatch`を書いていないリポジトリ（`guchi-apps/portfolio`）。
    // GitHubは422で落とすが、そのままでは「押し直せば通るのか」が読み取れない。**起動そのものの
    // 失敗と混ぜない**——押し直しても直らず、リポジトリ側にトリガーを足すしかないため。
    if (error instanceof GithubApiError && error.status === 422) {
      return NextResponse.json({ error: "deploy_dispatch_unsupported" }, { status: 400 });
    }
    console.error(`[POST /api/repositories/deploy] ${owner}/${repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
