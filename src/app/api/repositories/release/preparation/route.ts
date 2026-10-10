import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { dispatchReleaseWorkflow } from "@/lib/github/release-api";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";
import { previewModeGuard } from "@/lib/preview-mode";
import { releasePreparationNextAction } from "@/lib/release-preparation";
import { findOpenReleasePreparationFailure } from "@/lib/release-preparation-run";
import { isBumpKind } from "@/lib/semver-bump";

/**
 * リリース準備の失敗（#4335）の表示と再開。
 *
 * - GET: 未解決の失敗（失敗した工程・エラー行・実行ログ・次の操作）。無ければ`failure: null`
 * - POST: 失敗したときと同じ上げ幅でリリースworkflowを起動し直す。失敗の記録は、次のrunで
 *   準備が進んだ報告（`notify-prepared`）が届いた時点で解決になる（押しただけでは消さない）
 */

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  if (!owner || !repo) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  if (!(await findRepository(userId, owner, repo))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const failure = await findOpenReleasePreparationFailure(`${owner}/${repo}`);
  return NextResponse.json(
    { failure: failure ? { ...failure, nextAction: releasePreparationNextAction(failure) } : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_dispatch", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const failureId = payload?.failureId;
  if (typeof owner !== "string" || typeof repo !== "string" || typeof failureId !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // 画面を開いた後に解決・更新されていたら起動しない（二重起動を避ける）
  const failure = await findOpenReleasePreparationFailure(`${owner}/${repo}`);
  if (!failure || failure.id !== failureId) {
    return NextResponse.json({ error: "failure_changed" }, { status: 409 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    if (!(await releaseWorkflowExists(owner, repo, token))) {
      return NextResponse.json({ error: "release_workflow_missing" }, { status: 400 });
    }
    await dispatchReleaseWorkflow(owner, repo, token, isBumpKind(failure.bumpKind) ? failure.bumpKind : undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[POST /api/repositories/release/preparation]", error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
