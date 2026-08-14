import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { cancelDispatchJob } from "@/lib/dispatch/jobs";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 積んだジョブを画面から取り消す（#1179）。
 *
 * **取り消せるのは`queued`と`claimed`まで。** `running`はworktreeの作成や依存インストールの
 * 最中で、途中で止めると中途半端なworktreeとブランチが残る。理由は
 * `cancelDispatchJob`（src/lib/dispatch/jobs.ts）が本文で返す。
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await cancelDispatchJob({ jobId: id });

  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return NextResponse.json(
      { error: result.reason, message: result.message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, job: result.job },
    { headers: { "Cache-Control": "no-store" } },
  );
}
