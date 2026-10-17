import type { DeployRunObservation } from "@/lib/deploy-recovery-series";
import { hasVersionVerification } from "@/lib/deploy-recovery-series-run";
import { fetchFileTextAtRef, isAncestorCommit } from "@/lib/github/release-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { decideSuccessorProof } from "@/lib/release-production-stop";
import { classifyProductionTarget, type ProductionTargetKind } from "@/lib/release-production-verification";

/**
 * 稼働確認の停止（#4712）の観測。判断は`release-production-stop.ts`の純関数が持ち、ここはGitHubから材料を取るだけ。
 * **読めなかったことを「照合が無い」と取り違えない**（読めなければnullを返す）。
 */

type Ctx = { owner: string; repo: string; token: string };

/** `ref`（SHA・ブランチ）時点の配布方式（#4713の判定）。読めなければnull（404は「無い」として判定に使う） */
export async function readProductionTargetKind(ctx: Ctx, ref: string): Promise<ProductionTargetKind | null> {
  try {
    const deployWorkflowText = await fetchFileTextAtRef(ctx.owner, ctx.repo, ".github/workflows/deploy.yml", ref, ctx.token);
    const releaseArtifactsWorkflowText =
      deployWorkflowText === null ? await fetchFileTextAtRef(ctx.owner, ctx.repo, ".github/workflows/release-artifacts.yml", ref, ctx.token) : null;
    return classifyProductionTarget({ deployWorkflowText, releaseArtifactsWorkflowText });
  } catch (error) {
    console.error("[release-production] 配布workflowを読めませんでした", ctx.owner, ctx.repo, ref, error);
    return null;
  }
}

async function fetchLatestMainDeployRun(ctx: Ctx): Promise<DeployRunObservation | null> {
  try {
    const response = await githubFetch(`${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/actions/workflows/deploy.yml/runs?branch=main&per_page=10`, ctx.token);
    if (!response.ok) return null;
    const data: {
      workflow_runs?: { id: number; html_url: string; created_at?: string; head_sha: string; status: string; conclusion: string | null; run_attempt?: number }[];
    } = await response.json();
    const runs = (data.workflow_runs ?? []).map((run) => ({
      id: run.id,
      htmlUrl: run.html_url,
      createdAt: run.created_at ?? "",
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      attempt: run.run_attempt ?? 1,
    }));
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0] ?? null;
  } catch (error) {
    console.error("[release-production] mainのdeployを読めませんでした", ctx.owner, ctx.repo, error);
    return null;
  }
}

/**
 * 後続の版による確認（#4712）。mainの**最新の**deployが成功し、そのコミットの`deploy.yml`が稼働版を照合し、照合を含む
 * `deploy`ジョブが成功していて、対象コミットを祖先に持つときだけ認める。今動いている版で確かめるため、最新のrunが
 * 成功していなければ（失敗・進行中）認めない
 */
export async function observeSuccessorProof(ctx: Ctx, coveredSha: string): Promise<ReturnType<typeof decideSuccessorProof>> {
  const latest = await fetchLatestMainDeployRun(ctx);
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success" || latest.headSha === coveredSha) return { ok: false };
  const kind = await readProductionTargetKind(ctx, latest.headSha);
  if (kind !== "deploy_version_check") return { ok: false };
  const versionCheckPassed = await hasVersionVerification(ctx.owner, ctx.repo, latest, ctx.token);
  const includesCovered = await isAncestorCommit(ctx.owner, ctx.repo, coveredSha, latest.headSha, ctx.token).catch(() => false);
  return decideSuccessorProof({ coveredSha, successor: { sha: latest.headSha, runUrl: latest.htmlUrl, kind, versionCheckPassed, includesCovered } });
}
