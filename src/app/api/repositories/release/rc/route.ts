import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { parseRcRequestKey } from "@/lib/release-rc";
import {
  cancelReleaseRc,
  createReleaseRc,
  loadRcOverview,
  migrateLegacyReleaseCandidate,
  requestRcImport,
  type RcMutationResult,
} from "@/lib/release-rc-run";

/**
 * 正式版を上げる前に固定したリリース候補（#4495）。
 *
 * - GET: 候補の状況（caller対応・進行中の候補またはPRに対応する候補・開いている旧方式の候補）
 * - POST `action=create`: developの先端を固定して候補を作る
 * - POST `action=import`: 関連修正（と明示的に承認したPR）を取り込み、revisionを進める
 * - POST `action=cancel`: 候補を取り消す（記録は残す）
 * - POST `action=migrate`: 開いている旧方式の候補を新方式へ移す
 *
 * **進めてよいかはサーバーが判定する。** 画面が送るのは要求キー・見ていたhead・選んだPRだけで、
 * 状態・SHA・承認範囲は`release-rc-run.ts`がGitHubと記録から取り直して確かめる。
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

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

const STATUS_BY_ERROR: Record<string, number> = { not_found: 404, invalid_selection: 400, empty_selection: 400, dispatch_failed: 502 };

function respond(result: RcMutationResult) {
  if (result.ok) return NextResponse.json(result);
  return NextResponse.json(result, { status: STATUS_BY_ERROR[result.error] ?? 409 });
}

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const owner = request.nextUrl.searchParams.get("owner");
  const repo = request.nextUrl.searchParams.get("repo");
  const prParam = request.nextUrl.searchParams.get("pullRequest");
  const pullRequestNumber = prParam === null ? undefined : Number(prParam);
  if (!owner || !repo || (pullRequestNumber !== undefined && (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const overview = await loadRcOverview({ owner, repo, token, pullRequestNumber });
    return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[GET /api/repositories/release/rc] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
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
  if (!owner || !repo || !action) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const ctx = { owner, repo, token, userId };
    switch (action) {
      case "create": {
        const requestKey = parseRcRequestKey(payload?.requestKey);
        if (!requestKey) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
        return respond(await createReleaseRc({ ...ctx, requestKey }));
      }
      case "import": {
        const requestKey = parseRcRequestKey(payload?.requestKey);
        const candidateId = readString(payload?.candidateId);
        const expectedHeadSha = readString(payload?.expectedHeadSha);
        const selected = Array.isArray(payload?.selected) ? (payload.selected as unknown[]) : null;
        if (!requestKey || !candidateId || !expectedHeadSha || !selected) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
        const items = selected.flatMap((item) => {
          const number = readPositiveInt((item as { number?: unknown })?.number);
          return number === null ? [] : [{ number, expectedMergeSha: readString((item as { expectedMergeSha?: unknown })?.expectedMergeSha) }];
        });
        const approveExtra = Array.isArray(payload?.approveExtra)
          ? (payload.approveExtra as unknown[]).flatMap((n) => (readPositiveInt(n) === null ? [] : [n as number]))
          : [];
        return respond(
          await requestRcImport({ ...ctx, candidateId, expectedHeadSha, selected: items, approveExtra, requestKey, source: "manual" }),
        );
      }
      case "cancel": {
        const candidateId = readString(payload?.candidateId);
        if (!candidateId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
        return respond(await cancelReleaseRc({ ...ctx, candidateId, reason: readString(payload?.reason) }));
      }
      case "migrate": {
        const requestKey = parseRcRequestKey(payload?.requestKey);
        const legacyPrNumber = readPositiveInt(payload?.legacyPrNumber);
        const expectedHeadSha = readString(payload?.expectedHeadSha);
        if (!requestKey || legacyPrNumber === null || !expectedHeadSha) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
        return respond(await migrateLegacyReleaseCandidate({ ...ctx, legacyPrNumber, expectedHeadSha, requestKey }));
      }
      default:
        return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
  } catch (error) {
    console.error(`[POST /api/repositories/release/rc] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
