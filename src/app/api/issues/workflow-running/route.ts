import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import {
  fetchWorkflowRun,
  fetchWorkflowRunJobs,
  type GithubApiWorkflowRun,
} from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  getIssueRunCache,
  issueRunCacheKey,
  setIssueRunCache,
} from "@/lib/github/issue-run-cache";
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
 *
 * このAPIは一覧に並ぶIssueの件数だけ定期的に呼ばれるため、GitHub APIの消費を抑える工夫を二段構えで入れている。
 * - `knownRunId`が指定され、かつその実行がまだ完了していない場合はコメント一覧の再取得を省略する。
 * - コメント件数（DB上の値）が前回と変わっていなければ、解決済みのrunId・完了状態をキャッシュから再利用する。
 *   完了済みと分かっている場合はGitHub APIを一度も呼ばずに応答する。
 */
export function GET(request: NextRequest) {
  return withGithubApiFeature("issue_list_workflow_running", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
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

  const issueNumber = Number(numberParam);

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // コメント件数はキャッシュの有効性判定にだけ使う。取得できない場合（同期前など）はキャッシュを使わない。
  const issueRow = await db.issue.findFirst({
    where: { repositoryId: repository.id, number: issueNumber },
    select: { commentCount: true },
  });
  const commentCount = issueRow?.commentCount ?? null;
  const cacheKey = issueRunCacheKey(owner, repo, issueNumber);
  const cached = commentCount === null ? null : getIssueRunCache(cacheKey, commentCount);

  function remember(runId: number | null, completed: boolean) {
    if (commentCount === null) return;
    setIssueRunCache(cacheKey, { runId, commentCount, completed });
  }

  // 実行が完了済みで、その後コメントが増えていない＝新しい実行ログも投稿されていないため、
  // GitHub APIを叩かずに「実行中でない」と返す。
  if (cached?.completed) {
    return NextResponse.json({ isRunning: false, currentStep: null, runId: cached.runId });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);

    let run: GithubApiWorkflowRun | null = null;
    let runId: number | null = null;

    // 追跡中のrunIdがまだ完了していなければ、コメント一覧の再取得を省略して実行状態だけ確認する
    if (knownRunId !== null) {
      const knownRun = await fetchWorkflowRun(owner, repo, knownRunId, token);
      if (knownRun.status !== "completed") {
        const currentStep = await fetchWorkflowRunJobs(owner, repo, knownRunId, token)
          .then(getCurrentStepName)
          .catch(() => null);
        // 進行中の実行は次のポーリングで最新の進捗を取り直すため、完了扱いではキャッシュしない
        remember(knownRunId, false);
        return NextResponse.json({ isRunning: true, currentStep, runId: knownRunId });
      }
      // 完了済みでも、その後に新しい実行が始まっている可能性があるためrunIdを解決し直す
      run = knownRun;
      runId = knownRunId;
    }

    const resolvedRunId = cached
      ? cached.runId
      : await fetchCommentsForIssue(owner, repo, issueNumber, token).then((rawComments) =>
          extractLatestWorkflowRunId(rawComments.map(mapComment), owner, repo),
        );

    if (resolvedRunId === null) {
      remember(null, true);
      return NextResponse.json({ isRunning: false, currentStep: null, runId: null });
    }

    if (run === null || resolvedRunId !== runId) {
      run = await fetchWorkflowRun(owner, repo, resolvedRunId, token);
    }

    const isRunning = run.status !== "completed";
    remember(resolvedRunId, !isRunning);
    if (!isRunning) {
      return NextResponse.json({ isRunning, currentStep: null, runId: resolvedRunId });
    }

    const currentStep = await fetchWorkflowRunJobs(owner, repo, resolvedRunId, token)
      .then(getCurrentStepName)
      .catch(() => null);
    return NextResponse.json({ isRunning, currentStep, runId: resolvedRunId });
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
