import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchWorkflowRun, fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import { getWorkflowRunBaseline } from "@/lib/github/workflow-run-baseline";
import { toWorkflowRunJobView, type WorkflowRunProgress } from "@/lib/workflow-run-progress";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

/**
 * GitHub Actionsの実行1件の内訳を返す（#2777）。
 *
 * 本番デプロイ（ブランチ画面）とCI（PR詳細）の**両方が同じ経路を使う**。どちらもGitHub
 * Actionsの実行でしかなく、見たいこと（ジョブがどこまで進んだか・あと何分か）も同じなので、
 * 状態の種類ごとに別のAPIを持たない。
 *
 * **消費するのは、画面でパネルを開いている間だけ**（`use-workflow-run-progress.ts`）。
 * 1回の呼び出しでrunとjobsの2リクエスト、加えて過去の実績を初回だけ引く（10分キャッシュ。
 * `workflow-run-baseline.ts`）。閉じている間は一切呼ばない。
 */
export function GET(request: NextRequest) {
  return withGithubApiFeature("workflow_run_progress", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const runIdParam = searchParams.get("runId");
  const runId = Number(runIdParam);

  if (!owner || !repo || !runIdParam || !Number.isSafeInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const [run, jobs] = await Promise.all([
      fetchWorkflowRun(owner, repo, runId, token),
      fetchWorkflowRunJobs(owner, repo, runId, token),
    ]);

    // 実績はワークフロー単位なので、run側からIDが取れたときだけ引く（取れなければ見込み無し）
    const baseline = run.workflow_id
      ? await getWorkflowRunBaseline(owner, repo, run.workflow_id, token)
      : { estimateMs: null, jobDurationsMs: {} };
    const baselineByJobName = new Map(Object.entries(baseline.jobDurationsMs));

    const progress: WorkflowRunProgress = {
      runId,
      htmlUrl: run.html_url ?? null,
      workflowName: run.name ?? null,
      status: run.status,
      conclusion: run.conclusion,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
      runAttempt: run.run_attempt ?? 1,
      jobs: jobs.map((job) => toWorkflowRunJobView(job, baselineByJobName)),
      estimateMs: baseline.estimateMs,
    };
    return NextResponse.json({ progress });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error(`[GET /api/workflow-runs] ${owner}/${repo} run ${runId}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
