import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { runReviewHandoffRescueSweep } from "@/lib/github/pull-request-review-handoff-rescue";
import { runPullRequestAutoRepairSweep } from "@/lib/github/pull-request-auto-repair-sweep";
import { previewModeGuard } from "@/lib/preview-mode";

/** サブPCのpollerが自動修復系列を進めるための内部入口。 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // handoffの取りこぼしを先に系列へ載せ、同じ巡回で進められるようにする（#4334）。失敗しても系列の巡回は止めない。
    const rescue = await runReviewHandoffRescueSweep().catch((error: unknown) => {
      console.error("[POST /api/pull-requests/auto-repair-sweep] handoffの拾い直しに失敗:", error);
      return null;
    });
    return NextResponse.json({ ok: true, ...(await runPullRequestAutoRepairSweep()), rescued: rescue?.started.length ?? 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[POST /api/pull-requests/auto-repair-sweep]", error);
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

/** PR詳細で自動修復系列のラウンドと停止理由を表示するための読み取り口。 */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const owner = request.nextUrl.searchParams.get("owner");
  const repo = request.nextUrl.searchParams.get("repo");
  const number = Number(request.nextUrl.searchParams.get("number"));
  if (!owner || !repo || !Number.isInteger(number) || number < 1) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await db.repository.findFirst({
    where: { fullName: `${owner}/${repo}`, installation: { userInstallations: { some: { userId } } } },
    select: { id: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const loop = await db.pullRequestAutoRepairLoop.findUnique({
    where: { repositoryFullName_pullRequestNumber: { repositoryFullName: `${owner}/${repo}`, pullRequestNumber: number } },
    select: { status: true, round: true, currentKind: true, stopReason: true },
  });
  return NextResponse.json({ loop }, { headers: { "Cache-Control": "no-store" } });
}
