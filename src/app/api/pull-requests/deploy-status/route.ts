import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { MAIN_BRANCH } from "@/lib/branch-flow";
import { db } from "@/lib/db";
import { findOpenDeployFailureIssue } from "@/lib/deploy-failure-store";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import {
  fetchClosedPullRequestsForBase,
  fetchPullRequest,
} from "@/lib/github/pull-requests-api";
import { fetchLatestDeployWorkflowRun } from "@/lib/github/release-api";
import {
  resolvePullRequestDeployStatus,
  type MainMergedPullRequest,
} from "@/lib/pull-request-deploy";
import type { PullRequestDeployStatusResponse } from "@/types/pull-request";

export function GET(request: NextRequest) {
  return withGithubApiFeature("deploy_status", () => handleGET(request));
}

/**
 * PR1件が本番へ届いたかを返す（#1814）。
 *
 * PR詳細（`/api/pull-requests/detail`）と分けているのは、**デプロイが動いている間だけ短い間隔で
 * 取り直す**ため（`hooks/use-pull-request-deploy-status.ts`）。詳細に相乗りさせると、その
 * 取り直しのたびに本文・コメント・レビューまで取り直すことになる。
 *
 * 消費するのはGitHub REST 3回（PR単体・mainへのクローズ済みPR一覧・`deploy.yml`の最新実行）。
 * **マージ済みのPRでなければPR単体の1回で打ち切る**（未マージのPRに出す状態が無いため）。
 * 後ろ2つはETagの条件付きGETを通すので、状況が動いていない間はレート制限を消費しない。
 */
async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const numberParam = searchParams.get("number");

  if (!owner || !repo || !numberParam || Number.isNaN(Number(numberParam))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const number = Number(numberParam);

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
    const pullRequest = await fetchPullRequest(owner, repo, number, token);

    if (!pullRequest.merged || pullRequest.merged_at === null) {
      return NextResponse.json(emptyResponse());
    }

    const [mainPullRequests, deployRun] = await Promise.all([
      fetchClosedPullRequestsForBase(owner, repo, MAIN_BRANCH, token),
      // `deploy.yml`が無いリポジトリではnullが返る。その場合は状態を出さない。
      fetchLatestDeployWorkflowRun(owner, repo, token),
    ]);

    const releases: MainMergedPullRequest[] = mainPullRequests
      .filter((item): item is typeof item & { merged_at: string } => item.merged_at !== null)
      .map((item) => ({
        number: item.number,
        title: item.title,
        // 運び手を決めるのは「内容を凍結した時刻」なので、headと作成時刻まで渡す（#2489）
        headRef: item.head.ref,
        createdAt: item.created_at,
        mergedAt: item.merged_at,
      }));

    const response: PullRequestDeployStatusResponse = {
      // 失敗しているときにだけ画面が使う（#2236）。DBを1回引くだけでGitHub APIは増えない。
      failureIssue: await findOpenDeployFailureIssue(repository.fullName),
      status: resolvePullRequestDeployStatus({
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          baseRef: pullRequest.base.ref,
          merged: pullRequest.merged,
          mergedAt: pullRequest.merged_at,
        },
        releases,
        deployRun,
        now: Date.now(),
      }),
      fetchedAt: new Date().toISOString(),
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error(`[GET /api/pull-requests/deploy-status] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}

function emptyResponse(): PullRequestDeployStatusResponse {
  return { status: null, failureIssue: null, fetchedAt: new Date().toISOString() };
}
