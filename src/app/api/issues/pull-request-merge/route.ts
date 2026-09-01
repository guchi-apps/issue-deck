import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { mergePullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { recordDeployLaunchWatch } from "@/lib/github/deploy-launch-watch";
import { GithubApiError } from "@/lib/github/issues-api";
import { previewModeGuard } from "@/lib/preview-mode";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_merge", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: { owner?: string; repo?: string; number?: number } = await request
    .json()
    .catch(() => ({}));
  const { owner, repo, number } = body;

  if (!owner || !repo || !number || Number.isNaN(Number(number))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const merged = await mergePullRequest(owner, repo, Number(number), token);

    // mainへのマージなら、本番デプロイが本当に起動したかを見張る行を1つ置く（#2703）。
    // **GitHubはマージのイベントを配送し損ねることがあり**、そのときはワークフローの定義が
    // 正しくても`deploy.yml`の実行が1件も作られない（myroom#315。mainへのマージ55件中1件）。
    // 実際の見張りはpollerが叩く巡回（`/api/repositories/deploy-launch-sweep`）が行う。
    //
    // **ここで失敗してもマージは成功として返す。** 見張りが立たないだけで、マージそのものは
    // 済んでおり、押し直させると二重マージを試みることになる。
    let deployLaunchWatched = false;
    try {
      deployLaunchWatched = await recordDeployLaunchWatch({
        owner,
        repo,
        pullRequestNumber: Number(number),
        mergeCommitSha: merged.sha,
        token,
      });
    } catch (error) {
      console.error(
        `[POST /api/issues/pull-request-merge] 見張りの記録に失敗しました ${owner}/${repo}#${number}:`,
        error,
      );
    }

    return NextResponse.json({ ok: true, deployLaunchWatched });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error(`[POST /api/issues/pull-request-merge] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
