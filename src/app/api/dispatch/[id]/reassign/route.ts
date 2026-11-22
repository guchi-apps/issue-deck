import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { reassignDispatchJob } from "@/lib/dispatch/jobs";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 順番待ちの起動ジョブを別のホストへ移す（#5589）。
 *
 * **人が画面で押した1回の操作だけ**（自動で振り替える経路は作らない）。押せるジョブ・移し先の
 * 可否の判定は`reassignDispatchJob`が持ち、理由は本文でそのまま返す。
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const toHostName =
    body && typeof body === "object" && "toHostName" in body ? (body as { toHostName: unknown }).toHostName : null;
  if (typeof toHostName !== "string" || toHostName.length === 0) {
    return NextResponse.json({ error: "invalid_request", message: "移し先のホストを指定してください。" }, { status: 400 });
  }

  const { id } = await params;
  const result = await reassignDispatchJob({ jobId: id, toHostName });

  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return NextResponse.json(
      { error: result.reason, message: result.message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json({ ok: true, job: result.job }, { headers: { "Cache-Control": "no-store" } });
}
