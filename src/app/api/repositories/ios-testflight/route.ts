import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import {
  dispatchIosTestflightWorkflow,
  fetchDeployRunForSha,
  fetchMainHeadSha,
  fetchPullMergeInfo,
  fetchTagRefs,
} from "@/lib/github/release-api";
import {
  fetchCompletedJobAnnotations,
  fetchIosRunJobs,
  fetchRecentIosRuns,
} from "@/lib/github/ios-testflight-fetch";
import {
  checkIosDispatchable,
  deliveredBuildForSha,
  IOS_STAGES,
  IOS_TESTFLIGHT_TAG_PREFIX,
  judgeIosRun,
  latestDeliveredBuildWithVersion,
  summarizeIosStages,
  toWebDeployState,
} from "@/lib/ios-testflight-status";
import { previewModeGuard } from "@/lib/preview-mode";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";

const RUN_LIMIT = 3;

export function GET(request: NextRequest) {
  return withGithubApiFeature("ios_testflight", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  if (!owner || !repo) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  // ブランチ画面の束用（#3644）。指定があるときだけ、その版（リリースPR）の配布状態を添える
  const prParam = searchParams.get("pr");
  const prNumber = prParam === null ? null : Number(prParam);
  if (prNumber !== null && !Number.isInteger(prNumber)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  // 対象は固定リストのリポジトリだけ（他リポジトリでワークフローを探す呼び出しを増やさない）
  if (!getWebviewIosRepository(`${owner}/${repo}`)) {
    return NextResponse.json({ available: false });
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

    // 画面が数十秒おきに取り直すため、run一覧・タグは条件付きGETにして、変化が無い間は枠を消費しない（#5438）
    const [recentRuns, tagRefs, versionTagRefs] = await Promise.all([
      fetchRecentIosRuns(owner, repo, token, RUN_LIMIT),
      fetchTagRefs(owner, repo, token, IOS_TESTFLIGHT_TAG_PREFIX),
      fetchTagRefs(owner, repo, token, "v"),
    ]);

    // ワークフローがまだ無いリポジトリ（kurashio#591の反映前）は「未導入」として返す
    if (!recentRuns) {
      return NextResponse.json({ available: false });
    }

    const latestBuild = latestDeliveredBuildWithVersion(tagRefs, versionTagRefs);

    // 束（リリースPR）の指定があれば、mergeコミットがmain先端か・Webの本番デプロイが済んだかを調べる。
    // 先端でない束はrunと対応づけられない（`head_sha`は起動時のmain先端）ので、runのジョブは取らない
    let release: {
      sha: string | null;
      merged: boolean;
      isMainTip: boolean;
      webDeploy: "success" | "pending" | "failed";
      deliveredBuild: number | null;
    } | null = null;
    if (prNumber !== null) {
      const [pull, mainTip] = await Promise.all([
        fetchPullMergeInfo(owner, repo, token, prNumber),
        fetchMainHeadSha(owner, repo, token),
      ]);
      const sha = pull?.merged && pull.baseRef === "main" ? pull.mergeCommitSha : null;
      const isMainTip = sha !== null && sha === mainTip;
      release = {
        sha,
        merged: sha !== null,
        isMainTip,
        webDeploy: isMainTip ? toWebDeployState(await fetchDeployRunForSha(owner, repo, token, sha)) : "pending",
        deliveredBuild:
          sha === null
            ? null
            : deliveredBuildForSha(tagRefs, sha),
      };
    }
    const workflowRuns =
      release !== null && !release.isMainTip
        ? recentRuns.filter((run) => run.status !== "completed")
        : recentRuns;

    const runs = await Promise.all(
      workflowRuns.map(async (run) => {
        // 完了したrunのjobsは覚えて返す（#5438）
        const jobs = await fetchIosRunJobs(owner, repo, run, token);
        const stages = summarizeIosStages(jobs);
        const verdict = judgeIosRun(run, stages);

        // 判定ジョブの注釈（`::notice::`）に書かれた理由を、更新要否・スキップ理由として出す。
        // 完了した実行の先頭1件にだけ取る（実行中は判定前のことがある）
        let notes: string[] = [];
        const detectJob = jobs.find((j) => IOS_STAGES[0].pattern.test(j.name));
        if (detectJob && run.status === "completed" && run.id === recentRuns[0].id) {
          const annotations = await fetchCompletedJobAnnotations(owner, repo, detectJob.id, token);
          notes = annotations
            .filter((a) => a.annotation_level !== "failure" && a.message)
            .map((a) => a.message as string)
            .slice(0, 5);
        }

        return {
          id: run.id,
          htmlUrl: run.html_url,
          headSha: run.head_sha,
          headBranch: run.head_branch,
          event: run.event,
          createdAt: run.created_at,
          updatedAt: run.updated_at ?? run.created_at,
          status: run.status,
          conclusion: run.conclusion,
          verdict,
          stages,
          notes,
        };
      }),
    );

    // 追跡Issue（自動起票または画面から起票したもの。#3784）。画面が「起票済み」の表示に使う
    const tracked = await db.iosDistributionFailureIssue.findFirst({
      where: { repositoryFullName: `${owner}/${repo}`, state: "open" },
      orderBy: { detectedAt: "desc" },
      select: { issueNumber: true },
    });

    return NextResponse.json({
      available: true,
      latestDeliveredBuild: latestBuild,
      runs,
      trackedIssue: tracked
        ? { number: tracked.issueNumber, htmlUrl: `https://github.com/${owner}/${repo}/issues/${tracked.issueNumber}` }
        : null,
      ...(release ? { release } : {}),
    });
  } catch (error) {
    console.error(`[GET /api/repositories/ios-testflight] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
}

/** 起動直後はrunが一覧に出るまで数秒あき、その間は「実行中なし」に見える。同じリポジトリへの再POSTを弾く時間 */
const RECENT_DISPATCH_MS = 60_000;
const recentDispatches = new Map<string, number>();

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("ios_testflight_dispatch", () => handlePOST(request));
}

/**
 * リリース束のmainコミットを指定して`ios-testflight.yml`を起動する（#3644）。
 *
 * 対象コミットはクライアントから受け取らず、リリースPRの番号からサーバーが引く（任意のSHAを起動させない）。
 * 起動してよいのは、そのPRがmainへマージ済みで、mergeコミットがいまのmain先端であり、Webの本番デプロイが
 * 成功し、未配布で、実行中のrunが無いときだけ。画面の非活性に頼らず、ここでも確かめる。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const prNumber = payload?.prNumber;
  const force = payload?.force === true;
  if (typeof owner !== "string" || typeof repo !== "string" || !Number.isInteger(prNumber)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!getWebviewIosRepository(`${owner}/${repo}`)) {
    return NextResponse.json({ error: "unsupported_repository" }, { status: 400 });
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

    const [recentRuns, tagRefs, pull, mainTip] = await Promise.all([
      fetchRecentIosRuns(owner, repo, token, 10),
      fetchTagRefs(owner, repo, token, IOS_TESTFLIGHT_TAG_PREFIX),
      fetchPullMergeInfo(owner, repo, token, prNumber),
      fetchMainHeadSha(owner, repo, token),
    ]);
    if (!recentRuns) {
      return NextResponse.json({ error: "ios_workflow_missing" }, { status: 400 });
    }

    const sha = pull?.merged && pull.baseRef === "main" ? pull.mergeCommitSha : null;
    const isMainTip = sha !== null && sha === mainTip;
    const webDeploy = isMainTip
      ? toWebDeployState(await fetchDeployRunForSha(owner, repo, token, sha))
      : "pending";
    const block = checkIosDispatchable({
      merged: sha !== null,
      isMainTip,
      webDeploy,
      deliveredBuild:
        sha === null
          ? null
          : deliveredBuildForSha(tagRefs, sha),
      hasActiveRun: recentRuns.some((run) => run.status !== "completed"),
    });
    if (block !== null || sha === null) {
      return NextResponse.json({ error: block ?? "not_merged" }, { status: 409 });
    }
    // 手動配布（#3840）は、この版のrunが判定を終えて成功している（＝更新不要で終わった）ときだけ。
    // 未判定の版や失敗した版は、通常の配布・再実行で足りる
    if (
      force &&
      !recentRuns.some(
        (run) => run.head_sha === sha && run.status === "completed" && run.conclusion === "success",
      )
    ) {
      return NextResponse.json({ error: "force_not_needed" }, { status: 409 });
    }

    const key = `${owner}/${repo}`;
    const last = recentDispatches.get(key);
    if (last !== undefined && Date.now() - last < RECENT_DISPATCH_MS) {
      return NextResponse.json({ error: "run_in_progress" }, { status: 409 });
    }
    recentDispatches.set(key, Date.now());

    try {
      await dispatchIosTestflightWorkflow(owner, repo, token, sha, force);
    } catch (error) {
      recentDispatches.delete(key);
      // 入力`force`をワークフローが宣言していないと422になる。通常の配布へ落とさず、未対応として返す
      if (force && error instanceof GithubApiError && error.status === 422) {
        return NextResponse.json({ error: "force_unsupported" }, { status: 409 });
      }
      throw error;
    }
    return NextResponse.json({ ok: true, sha });
  } catch (error) {
    console.error(`[POST /api/repositories/ios-testflight] ${owner}/${repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
