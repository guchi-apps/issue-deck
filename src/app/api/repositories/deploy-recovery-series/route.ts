import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import {
  findLatestDeployRecoverySeries,
  startDeployRecoverySeries,
  stopDeployRecoverySeries,
} from "@/lib/deploy-recovery-series-run";
import { getInstallationToken } from "@/lib/github/app-auth";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * デプロイ失敗の帯の「AIに修正を依頼」（#3998）。GETで直近の系列、POSTで開始、DELETEで停止。
 *
 * **開始の権限はここで確かめ、記録する。** リポジトリへのアクセス権（インストール経由）がある人だけが
 * 開始でき、開始者・許可範囲・期限は系列の行に残す。ラベルやPR本文のマーカーでは権限を与えない。
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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const owner = request.nextUrl.searchParams.get("owner");
  const repo = request.nextUrl.searchParams.get("repo");
  if (!owner || !repo) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    { series: await findLatestDeployRecoverySeries(`${owner}/${repo}`) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const owner = readString(payload?.owner);
  const repo = readString(payload?.repo);
  const runId = payload?.runId;
  if (!owner || !repo || typeof runId !== "number" || !Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const result = await startDeployRecoverySeries({ repositoryFullName: `${owner}/${repo}`, runId, userId, token });
    if (!result.ok) return NextResponse.json(result, { status: 409 });
    return NextResponse.json(result);
  } catch (error) {
    console.error(`[POST /api/repositories/deploy-recovery-series] ${owner}/${repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const owner = readString(payload?.owner);
  const repo = readString(payload?.repo);
  const seriesId = readString(payload?.seriesId);
  if (!owner || !repo || !seriesId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const series = await stopDeployRecoverySeries({ repositoryFullName: `${owner}/${repo}`, seriesId, userId, token });
    if (!series) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ series });
  } catch (error) {
    console.error(`[DELETE /api/repositories/deploy-recovery-series] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "stop_failed" }, { status: 500 });
  }
}
