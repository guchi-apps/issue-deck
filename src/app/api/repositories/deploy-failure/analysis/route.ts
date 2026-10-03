import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import {
  analyzeDeployFailure,
  tailDeployLog,
} from "@/lib/claude/deploy-failure-analysis";
import { getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";
import { fetchWorkflowJobLogs, fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";

/**
 * デプロイ失敗の帯の「原因をAIに聞く」（#3887）。失敗したジョブのログ末尾から原因を推定して返す。
 *
 * **ログも対象のジョブもサーバーがGitHubから読み直す。** 画面が送るのはリポジトリとrun idだけで、
 * 画面が送った文字列をそのままAIへ渡さない。ログは送る前に秘密値を伏せる（`sanitizeDeployLog`）。
 * **返すのは提案まで**で、修正Issueを立てるのは人が押したとき。
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const aiToken = await getAppAiToken("deploy_failure_analysis");
  if (!aiToken) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const runId = payload?.runId;
  const version = typeof payload?.version === "string" ? payload.version : null;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof runId !== "number" ||
    !Number.isInteger(runId) ||
    runId <= 0
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
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
    const jobs = await fetchWorkflowRunJobs(owner, repo, runId, token);
    const failed = jobs.filter((job) => job.conclusion === "failure" && typeof job.id === "number");
    if (failed.length === 0) {
      return NextResponse.json({ error: "no_failed_job" }, { status: 404 });
    }

    // 失敗ジョブが複数でも、最初に落ちたものを読む（後続は連鎖で落ちていることが多い）
    const target = failed[0];
    const rawLog = await fetchWorkflowJobLogs(owner, repo, target.id as number, token);
    const analysis = await analyzeDeployFailure(aiToken, {
      repositoryFullName: `${owner}/${repo}`,
      version,
      failedJobs: failed.map((job) => job.name ?? "不明"),
      log: tailDeployLog(rawLog),
    });
    return NextResponse.json({ analysis, jobName: target.name ?? null });
  } catch (error) {
    console.error("[deploy-failure-analysis]", error);
    return NextResponse.json({ error: "analysis_failed" }, { status: 502 });
  }
}
