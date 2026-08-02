import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchWorkflowRun, fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { mapComment } from "@/lib/github/issue-mapper";
import { fetchCommentsForIssue, GithubApiError } from "@/lib/github/issues-api";
import { extractLatestWorkflowRunId } from "@/lib/github/workflow-run-log";
import { getCurrentStepName } from "@/lib/github/workflow-run-jobs";

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
 * 一覧画面向けに、Issueコメント中の直近の実行ログリンクが指すGitHub Actions実行が現在進行中かどうかと、
 * 進行中の場合は現在実行中のステップ名を返す。
 * `knownRunId`が指定され、かつその実行がまだ完了していない場合はコメント一覧の再取得を省略する。
 */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const numberParam = searchParams.get("number");
  const knownRunIdParam = searchParams.get("knownRunId");
  const knownRunId =
    knownRunIdParam && !Number.isNaN(Number(knownRunIdParam)) ? Number(knownRunIdParam) : null;

  if (!owner || !repo || !numberParam || Number.isNaN(Number(numberParam))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);

    // 追跡中のrunIdがまだ完了していなければ、コメント一覧の再取得を省略して実行状態だけ確認する
    if (knownRunId !== null) {
      const knownRun = await fetchWorkflowRun(owner, repo, knownRunId, token);
      if (knownRun.status !== "completed") {
        const currentStep = await fetchWorkflowRunJobs(owner, repo, knownRunId, token)
          .then(getCurrentStepName)
          .catch(() => null);
        return NextResponse.json({ isRunning: true, currentStep, runId: knownRunId });
      }
    }

    const rawComments = await fetchCommentsForIssue(owner, repo, Number(numberParam), token);
    const runId = extractLatestWorkflowRunId(rawComments.map(mapComment), owner, repo);
    if (!runId) {
      return NextResponse.json({ isRunning: false, currentStep: null, runId: null });
    }

    const run = await fetchWorkflowRun(owner, repo, runId, token);
    const isRunning = run.status !== "completed";
    if (!isRunning) {
      return NextResponse.json({ isRunning, currentStep: null, runId });
    }

    const currentStep = await fetchWorkflowRunJobs(owner, repo, runId, token)
      .then(getCurrentStepName)
      .catch(() => null);
    return NextResponse.json({ isRunning, currentStep, runId });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ isRunning: false, currentStep: null, runId: null });
    }
    console.error(`[GET /api/issues/workflow-running] ${owner}/${repo}#${numberParam}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
