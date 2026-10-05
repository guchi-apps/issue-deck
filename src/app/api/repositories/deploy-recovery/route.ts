import { NextResponse, type NextRequest } from "next/server";

import { normalizeDeployRecoverySelection } from "@/lib/deploy-recovery";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import {
  createDeployRecoveryPullRequest,
  DeployRecoveryConflictError,
  DeployRecoveryVerificationError,
  fetchDeployRecoveryCandidates,
} from "@/lib/github/deploy-recovery-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchLatestDeployWorkflowRun } from "@/lib/github/release-api";
import { previewModeGuard } from "@/lib/preview-mode";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

function parseRepository(value: unknown): { owner: string; repo: string } | null {
  if (!value || typeof value !== "object") return null;
  const { owner, repo } = value as { owner?: unknown; repo?: unknown };
  return typeof owner === "string" && typeof repo === "string" ? { owner, repo } : null;
}

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const repositoryRef = parseRepository(Object.fromEntries(new URL(request.url).searchParams));
  if (!repositoryRef) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repository = await findRepository(userId, repositoryRef.owner, repositoryRef.repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    return NextResponse.json(await fetchDeployRecoveryCandidates(repositoryRef.owner, repositoryRef.repo, token));
  } catch (error) {
    console.error(`[GET /api/repositories/deploy-recovery] ${repositoryRef.owner}/${repositoryRef.repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const repositoryRef = parseRepository(payload);
  const selected = normalizeDeployRecoverySelection(
    payload && typeof payload === "object" ? (payload as { pullRequestNumbers?: unknown }).pullRequestNumbers : null,
  );
  if (!repositoryRef || !selected) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repository = await findRepository(userId, repositoryRef.owner, repositoryRef.repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const latestDeploy = await fetchLatestDeployWorkflowRun(repositoryRef.owner, repositoryRef.repo, token);
    if (
      latestDeploy?.status !== "completed" ||
      (latestDeploy.conclusion !== "failure" && latestDeploy.conclusion !== "timed_out")
    ) {
      return NextResponse.json({ error: "deploy_not_failed" }, { status: 409 });
    }
    const result = await createDeployRecoveryPullRequest(
      repositoryRef.owner,
      repositoryRef.repo,
      token,
      selected,
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RangeError && error.message === "candidate_changed") {
      return NextResponse.json({ error: "candidate_changed" }, { status: 409 });
    }
    if (error instanceof DeployRecoveryConflictError) {
      return NextResponse.json({ error: "recovery_conflict", message: error.detail || undefined }, { status: 409 });
    }
    if (error instanceof DeployRecoveryVerificationError) {
      return NextResponse.json({ error: "recovery_unverified", message: error.message }, { status: 409 });
    }
    console.error(`[POST /api/repositories/deploy-recovery] ${repositoryRef.owner}/${repositoryRef.repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
