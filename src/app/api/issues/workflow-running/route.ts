import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchWorkflowRun } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { mapComment } from "@/lib/github/issue-mapper";
import { fetchCommentsForIssue, GithubApiError } from "@/lib/github/issues-api";
import { extractLatestWorkflowRunId } from "@/lib/github/workflow-run-log";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

/** 一覧画面向けに、Issueコメント中の直近の実行ログリンクが指すGitHub Actions実行が現在進行中かどうかだけを返す */
export async function GET(request: NextRequest) {
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

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const rawComments = await fetchCommentsForIssue(owner, repo, Number(numberParam), token);
    const runId = extractLatestWorkflowRunId(rawComments.map(mapComment), owner, repo);
    if (!runId) {
      return NextResponse.json({ isRunning: false });
    }

    const run = await fetchWorkflowRun(owner, repo, runId, token);
    return NextResponse.json({ isRunning: run.status !== "completed" });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ isRunning: false });
    }
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
