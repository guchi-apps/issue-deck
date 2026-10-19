import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import {
  loadFinalizationOverview,
  recheckRcProduction,
  reconcileRcFinalization,
  resolveRcCandidateId,
  settleReservationsOnCancel,
} from "@/lib/release-finalize-run";
import { ensureDevelopSync, observeDevelopSync } from "@/lib/release-develop-sync-run";
import { decideDevelopSync } from "@/lib/release-develop-sync";
import { recoverRcFixSeries } from "@/lib/release-fix-series-run";
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
 * - POST `action=develop_sync`: 公開内容をdevelopへ戻す同期PRを用意する（#4641。同期済み・作成済みなら何もしない）
 * - POST `action=recheck_production`: 稼働確認が止まった公開済み候補を、今から確かめ直す（#4712。証拠を代わりに書かない）
 * - POST `action=recover`: 取り込みが止まった候補の記録を候補ブランチと照合し直し、止まった修正系列を進め直す（#4895）
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
    const ctx = { owner, repo, token };
    // 公開準備・本番反映の進行を先に1巡進め、候補の状態（段階）を最新にしてから読む
    const candidateId = await resolveRcCandidateId(repository.fullName, pullRequestNumber);
    if (candidateId) await reconcileRcFinalization(ctx, candidateId).catch((error: unknown) => console.error("[release-finalize] reconcile failed", error));
    const overview = await loadRcOverview({ ...ctx, pullRequestNumber });
    const finalization = await loadFinalizationOverview(ctx, overview.candidate?.id ?? null, { reconcile: false });
    // 本番反映以降の候補には、公開結果とは別にdevelopへの同期の状況を添える（#4641。読むだけで同期PRは作らない）
    const developSync =
      overview.candidate && ["deploying", "verifying_production", "completed"].includes(overview.candidate.status.status)
        ? decideDevelopSync(await observeDevelopSync(ctx))
        : null;
    return NextResponse.json({ ...overview, finalization, developSync }, { headers: { "Cache-Control": "no-store" } });
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
        // 前回の公開がdevelopへ戻るまで作らない判定は`createReleaseRc`が持つ（#4641。未同期なら同期PRも用意する）
        return respond(await createReleaseRc({ ...ctx, requestKey }));
      }
      case "develop_sync": {
        // 画面の「同期PRを作成」。同期済み・同期PRが開いていれば何も作らず、今の状況を返す（#4641）
        return NextResponse.json({ ok: true, developSync: await ensureDevelopSync(ctx) });
      }
      case "recheck_production": {
        const candidateId = readString(payload?.candidateId);
        if (!candidateId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
        const result = await recheckRcProduction(ctx, candidateId);
        return NextResponse.json(result, { status: result.ok ? 200 : result.error === "not_found" ? 404 : 409 });
      }
      case "recover": {
        // 画面の「再取り込み・再確認」（#4895）。記録を書き換えてよいかは`recoverRcFixSeries`がGitHubと記録から判定する
        const pullRequestNumber = readPositiveInt(payload?.pullRequestNumber);
        if (pullRequestNumber === null) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
        const recovery = await recoverRcFixSeries({ repositoryFullName: repository.fullName, prNumber: pullRequestNumber, ctx: { owner, repo, token } });
        return NextResponse.json({ ok: true, ...recovery });
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
        const cancelled = await cancelReleaseRc({ ...ctx, candidateId, reason: readString(payload?.reason), expectedPhase: readString(payload?.expectedPhase) });
        // 公開前に中止した候補の版の予約は手放す（タグ・main上に版があれば消費済みにする）
        if (cancelled.ok && !cancelled.existing) await settleReservationsOnCancel(ctx, candidateId).catch((error: unknown) => console.error("[release-finalize] settle reservation failed", error));
        return respond(cancelled);
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
