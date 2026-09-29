import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  IOS_STAGES,
  IOS_TESTFLIGHT_TAG_PREFIX,
  IOS_TESTFLIGHT_WORKFLOW_FILE,
  judgeIosRun,
  latestDeliveredBuild,
  summarizeIosStages,
} from "@/lib/ios-testflight-status";
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
  run_attempt?: number;
};

type JobItem = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps?: { name: string; status: string; conclusion: string | null }[];
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
      getJson<{ ref: string }[]>(`${base}/git/matching-refs/tags/${IOS_TESTFLIGHT_TAG_PREFIX}`, token),
    ]);

    // ワークフローがまだ無いリポジトリ（kurashio#591の反映前）は「未導入」として返す
    if (!runsBody) {
      return NextResponse.json({ available: false });
    }

    const latestBuild = latestDeliveredBuild((tagRefs ?? []).map((r) => r.ref));

    const runs = await Promise.all(
      runsBody.workflow_runs.map(async (run) => {
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
    });
  } catch (error) {
    console.error(`[GET /api/repositories/ios-testflight] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
}
