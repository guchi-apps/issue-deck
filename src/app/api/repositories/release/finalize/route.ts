import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { FINALIZE_START_ERROR_LABEL } from "@/lib/release-finalize";
import { requestRcFinalize, type FinalizeMutationResult } from "@/lib/release-finalize-run";
import { parseRcRequestKey } from "@/lib/release-rc";
import { isBumpKind } from "@/lib/semver-bump";

/**
 * 公開準備（正式バンプ。#4496）。
 *
 * - POST `action=start`: 合格した候補を正式バンプする。上げ幅（`bumpKind`）は`major|minor|patch`の手動指定か、
 *   空・`auto`なら自動判定
 *
 * **進めてよいかはサーバーが判定する。** 画面が送るのは要求キー・見ていた候補のhead・上げ幅だけで、合格の有無・
 * mainの先端・版の予約・段階は`release-finalize-run.ts`が記録とGitHubから取り直して確かめる。
 * 起案は本番公開の実行ではない（公開はmainへのマージと既存の承認を通る）
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

const STATUS_BY_ERROR: Record<string, number> = { not_found: 404, invalid_bump_kind: 400, dispatch_failed: 502 };

function respond(result: FinalizeMutationResult) {
  if (result.ok) return NextResponse.json(result);
  const label = (FINALIZE_START_ERROR_LABEL as Record<string, string>)[result.error];
  return NextResponse.json({ ...result, message: result.message ?? label }, { status: STATUS_BY_ERROR[result.error] ?? 409 });
}

export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const owner = readString(payload?.owner);
  const repo = readString(payload?.repo);
  const action = readString(payload?.action);
  if (!owner || !repo || action !== "start") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const requestKey = parseRcRequestKey(payload?.requestKey);
  const candidateId = readString(payload?.candidateId);
  const expectedHeadSha = readString(payload?.expectedHeadSha);
  const rawKind = readString(payload?.bumpKind);
  if (!requestKey || !candidateId || !expectedHeadSha || (rawKind !== null && rawKind !== "auto" && !isBumpKind(rawKind))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    return respond(
      await requestRcFinalize({
        owner,
        repo,
        token,
        userId,
        candidateId,
        expectedHeadSha,
        bumpKind: rawKind === null || rawKind === "auto" ? null : (rawKind as "major" | "minor" | "patch"),
        requestKey,
      }),
    );
  } catch (error) {
    console.error(`[POST /api/repositories/release/finalize] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
