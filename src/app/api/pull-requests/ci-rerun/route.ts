import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchWorkflowRunsForHead, rerunWorkflowRun } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/issues-api";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { previewModeGuard } from "@/lib/preview-mode";
import { decideCiRerun, selectCiRuns, type CiRerunRun } from "@/lib/pull-request-ci-rerun";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

function toRun(run: Awaited<ReturnType<typeof fetchWorkflowRunsForHead>>[number]): CiRerunRun {
  return {
    id: run.id,
    name: run.name,
    path: run.path,
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
    headSha: run.head_sha,
    event: run.event,
    htmlUrl: run.html_url,
  };
}

/** 画面が対象workflow・状態・SHAを確認できるよう、現在のheadのCI runを返す */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const owner = params.get("owner");
  const repo = params.get("repo");
  const number = Number(params.get("number"));
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const current = await fetchPullRequest(owner, repo, number, token);
    const runs = (await fetchWorkflowRunsForHead(owner, repo, current.head.sha, token)).map(toRun);
    return NextResponse.json({ headSha: current.head.sha, runs: selectCiRuns(runs, current.head.sha) });
  } catch (error) {
    console.error(`[GET /api/pull-requests/ci-rerun] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json({ error: "github_api_error" }, { status: 502 });
  }
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_ci_rerun", () => handlePOST(request));
}

/**
 * PR詳細の「CIを再実行」（#4626）。現在のheadの`pull_request`イベントのCI runだけを再実行する。
 * AIレビュー・デプロイ・リリース系のworkflowは起動しない。`scope`は`failed`（失敗分）か`all`（全体）。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload: { owner?: unknown; repo?: unknown; number?: unknown; headSha?: unknown; scope?: unknown } =
    await request.json().catch(() => ({}));
  const { owner, repo, number, headSha, scope } = payload;
  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    typeof headSha !== "string" ||
    !headSha ||
    (scope !== "failed" && scope !== "all")
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const current = await fetchPullRequest(owner, repo, number, token);
    const runs = (await fetchWorkflowRunsForHead(owner, repo, current.head.sha, token)).map(toRun);
    const decision = decideCiRerun(
      { state: current.state, merged: current.merged, headSha: current.head.sha },
      headSha,
      runs,
      scope,
    );
    if (decision.action === "reject") {
      return NextResponse.json({ error: decision.code }, { status: 409 });
    }
    // 1件ずつ結果を集める。途中で失敗しても、再実行済みのrunを「全部失敗」と見せない
    const failedRuns: { id: number; name: string | null; status: number | null }[] = [];
    let permissionDenied = false;
    for (const runId of decision.runIds) {
      try {
        await rerunWorkflowRun(owner, repo, runId, decision.scope === "failed", token);
      } catch (error) {
        const status = error instanceof GithubApiError ? error.status : null;
        if (status === 403 && failedRuns.length === 0 && decision.runIds.indexOf(runId) === 0) {
          // 権限不足は全件共通なので即エラー
          permissionDenied = true;
          break;
        }
        console.error(`[POST /api/pull-requests/ci-rerun] ${owner}/${repo}#${number} run ${runId}:`, error);
        failedRuns.push({ id: runId, name: runs.find((r) => r.id === runId)?.name ?? null, status });
      }
    }
    if (permissionDenied) return NextResponse.json({ error: "permission_denied" }, { status: 403 });
    const rerunCount = decision.runIds.length - failedRuns.length;
    if (rerunCount === 0) {
      return NextResponse.json({ error: "github_api_error", failedRuns }, { status: 502 });
    }
    // 一部だけ成功したときは`ok`のまま失敗したrunを添えて返し、画面が部分成功を伝える
    return NextResponse.json({ ok: true, scope: decision.scope, rerunCount, failedRuns });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (error instanceof GithubApiError && error.status === 403) {
      return NextResponse.json({ error: "permission_denied" }, { status: 403 });
    }
    console.error(`[POST /api/pull-requests/ci-rerun] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
