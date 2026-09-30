import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  dispatchIosTestflightWorkflow,
  fetchDeployRunForSha,
  fetchMainHeadSha,
  fetchPullMergeInfo,
} from "@/lib/github/release-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  checkIosDispatchable,
  deliveredBuildForSha,
  IOS_STAGES,
  IOS_TESTFLIGHT_TAG_PREFIX,
  IOS_TESTFLIGHT_WORKFLOW_FILE,
  judgeIosRun,
  latestDeliveredBuild,
  summarizeIosStages,
  toWebDeployState,
} from "@/lib/ios-testflight-status";
import { previewModeGuard } from "@/lib/preview-mode";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";

type RunItem = {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  head_branch: string | null;
  event: string;
  created_at: string;
  updated_at?: string;
  run_attempt?: number;
};

type TagRef = { ref: string; object?: { sha?: string } };

type JobItem = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: {
    name: string;
    status: string;
    conclusion: string | null;
    started_at?: string | null;
    completed_at?: string | null;
  }[];
};

const RUN_LIMIT = 3;

export function GET(request: NextRequest) {
  return withGithubApiFeature("ios_testflight", () => handleGET(request));
}

async function getJson<T>(url: string, token: string): Promise<T | null> {
  const res = await githubFetch(url, token);
  if (!res.ok) return null;
  return (await res.json()) as T;
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
    const base = `${GITHUB_API}/repos/${owner}/${repo}`;

    const [runsBody, tagRefs] = await Promise.all([
      getJson<{ workflow_runs: RunItem[] }>(
        `${base}/actions/workflows/${IOS_TESTFLIGHT_WORKFLOW_FILE}/runs?per_page=${RUN_LIMIT}`,
        token,
      ),
      getJson<TagRef[]>(`${base}/git/matching-refs/tags/${IOS_TESTFLIGHT_TAG_PREFIX}`, token),
    ]);

    // ワークフローがまだ無いリポジトリ（kurashio#591の反映前）は「未導入」として返す
    if (!runsBody) {
      return NextResponse.json({ available: false });
    }

    const latestBuild = latestDeliveredBuild((tagRefs ?? []).map((r) => r.ref));

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
            : deliveredBuildForSha(
                (tagRefs ?? []).map((r) => ({ ref: r.ref, sha: r.object?.sha ?? "" })),
                sha,
              ),
      };
    }
    const workflowRuns =
      release !== null && !release.isMainTip
        ? runsBody.workflow_runs.filter((run) => run.status !== "completed")
        : runsBody.workflow_runs;

    const runs = await Promise.all(
      workflowRuns.map(async (run) => {
        const jobsBody = await getJson<{ jobs: JobItem[] }>(`${base}/actions/runs/${run.id}/jobs`, token);
        const jobs = jobsBody?.jobs ?? [];
        const stages = summarizeIosStages(jobs);
        const verdict = judgeIosRun(run, stages);

        // 判定ジョブの注釈（`::notice::`）に書かれた理由を、更新要否・スキップ理由として出す。
        // 完了した実行の先頭1件にだけ取る（実行中は判定前のことがある）
        let notes: string[] = [];
        const detectJob = jobs.find((j) => IOS_STAGES[0].pattern.test(j.name));
        if (detectJob && run.status === "completed" && run.id === runsBody.workflow_runs[0].id) {
          const annotations = await getJson<{ message?: string; annotation_level?: string }[]>(
            `${base}/check-runs/${detectJob.id}/annotations`,
            token,
          );
          notes = (annotations ?? [])
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

    return NextResponse.json({
      available: true,
      latestDeliveredBuild: latestBuild,
      runs,
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
    const base = `${GITHUB_API}/repos/${owner}/${repo}`;

    const [runsBody, tagRefs, pull, mainTip] = await Promise.all([
      getJson<{ workflow_runs: RunItem[] }>(
        `${base}/actions/workflows/${IOS_TESTFLIGHT_WORKFLOW_FILE}/runs?per_page=10`,
        token,
      ),
      getJson<TagRef[]>(`${base}/git/matching-refs/tags/${IOS_TESTFLIGHT_TAG_PREFIX}`, token),
      fetchPullMergeInfo(owner, repo, token, prNumber),
      fetchMainHeadSha(owner, repo, token),
    ]);
    if (!runsBody) {
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
          : deliveredBuildForSha(
              (tagRefs ?? []).map((r) => ({ ref: r.ref, sha: r.object?.sha ?? "" })),
              sha,
            ),
      hasActiveRun: runsBody.workflow_runs.some((run) => run.status !== "completed"),
    });
    if (block !== null || sha === null) {
      return NextResponse.json({ error: block ?? "not_merged" }, { status: 409 });
    }

    const key = `${owner}/${repo}`;
    const last = recentDispatches.get(key);
    if (last !== undefined && Date.now() - last < RECENT_DISPATCH_MS) {
      return NextResponse.json({ error: "run_in_progress" }, { status: 409 });
    }
    recentDispatches.set(key, Date.now());

    try {
      await dispatchIosTestflightWorkflow(owner, repo, token, sha);
    } catch (error) {
      recentDispatches.delete(key);
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
