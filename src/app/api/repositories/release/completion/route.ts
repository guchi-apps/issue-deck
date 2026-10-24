import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { parseReleaseCompletionScope } from "@/lib/release-completion";
import {
  findReleaseCompletionRunForPullRequest,
  startReleaseCompletionRun,
  stopReleaseCompletionRun,
} from "@/lib/release-completion-run";

/**
 * リリース候補の「修正を自動で続ける」（#4480）。GETでこの候補の系列、POSTで開始、DELETEで停止。
 *
 * **開始の権限はここで確かめ、記録する。** リポジトリへのアクセス権（インストール経由）がある人だけが開始でき、
 * 開始者・許可範囲・期限は系列の行に残す。本番へのマージはこの記録だけを根拠にし、ラベルやPR本文では権限を与えない。
 */

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: { fullName: `${owner}/${repo}`, installation: { userInstallations: { some: { userId } } } },
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
  const number = Number(request.nextUrl.searchParams.get("pullRequest"));
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  if (!(await findRepository(userId, owner, repo))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    { run: await findReleaseCompletionRunForPullRequest(`${owner}/${repo}`, number) },
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
  const pullRequestNumber = payload?.pullRequestNumber;
  // 許可する範囲はサーバーが検証する。省略は受け付けない（本番まで進めるかを開始者が必ず選ぶ）
  const scope = parseReleaseCompletionScope(payload?.scope);
  if (!owner || !repo || scope === null || typeof pullRequestNumber !== "number" || !Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const result = await startReleaseCompletionRun({
      owner,
      repo,
      token,
      userId,
      pullRequestNumber,
      baseSha: readString(payload?.baseSha) ?? undefined,
      headSha: readString(payload?.headSha) ?? undefined,
      scope,
    });
    if (!result.ok) return NextResponse.json(result, { status: result.error === "not_release_pull_request" ? 404 : 409 });
    return NextResponse.json(result);
  } catch (error) {
    console.error(`[POST /api/repositories/release/completion] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
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
  const runId = readString(payload?.runId);
  if (!owner || !repo || !runId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const run = await stopReleaseCompletionRun({ repositoryFullName: `${owner}/${repo}`, runId, userId, token });
    if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    console.error(`[DELETE /api/repositories/release/completion] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "stop_failed" }, { status: 500 });
  }
}
