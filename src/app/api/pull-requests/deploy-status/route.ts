import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { isDevelopContentInMain, MAIN_BRANCH } from "@/lib/branch-flow";
import { db } from "@/lib/db";
import { findOpenDeployFailureIssue } from "@/lib/deploy-failure-store";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { lookupBranchRefs } from "@/lib/github/branches-api";
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
 * 消費するのはGitHub REST 3回（PR単体・mainへのクローズ済みPR一覧・`deploy.yml`の最新実行）と、
 * 「本番未反映」と判定したときだけのGraphQL 1回（`main...develop`の比較。#2704）。
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

    const input = {
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
    };
    let status = resolvePullRequestDeployStatus(input);

    // 「本番未反映」と言い切る前に、developの中身がmainに入りきっていないかだけ確かめる
    // （#2704）。back-mergeのように、コミットはdevelopにしか無いが中身はmainにある状態が
    // あるため。**この判定が要るときにしか取りに行かない**（GraphQL 1回・ブランチの存在確認は
    // 空で呼ぶ）ので、既に版が決まっているPRでは消費が増えない。
    if (
      status?.kind === "develop-only" &&
      (await isDevelopContentAlreadyInMain(owner, repo, token))
    ) {
      status = resolvePullRequestDeployStatus({ ...input, developContentInMain: true });
    }

    const response: PullRequestDeployStatusResponse = {
      // 失敗しているときにだけ画面が使う（#2236）。DBを1回引くだけでGitHub APIは増えない。
      failureIssue: await findOpenDeployFailureIssue(repository.fullName),
      status,
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

/**
 * `develop`の中身が`main`に入りきっているか（#2704）。取得に失敗したらfalse。
 *
 * **ここで落ちてもバッジ全体を落とさない。** 判定できなければ従来どおり「本番未反映」を
 * 出せばよく、この確認のために502を返す方が害が大きい。
 */
async function isDevelopContentAlreadyInMain(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  try {
    const { developVsMain } = await lookupBranchRefs(owner, repo, [], token);
    return isDevelopContentInMain(developVsMain);
  } catch (error) {
    console.warn(`[GET /api/pull-requests/deploy-status] compare ${owner}/${repo}:`, error);
    return false;
  }
}

function emptyResponse(): PullRequestDeployStatusResponse {
  return { status: null, failureIssue: null, fetchedAt: new Date().toISOString() };
}
