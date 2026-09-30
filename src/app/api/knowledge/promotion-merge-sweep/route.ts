import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { runPromotionMergeSweep } from "@/lib/github/knowledge-promotion-merge-run";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 共通知識の反映PR（`guchi-apps/docs`の`knowledge/promote-*`）を自動でマージする（#3645）。
 * 呼ぶのはサブPCのpoller。認証はディスパッチAPIと同じ`DISPATCH_SECRET`で、間隔の判定は
 * `runPromotionMergeSweep`が持つ。リクエストボディは不要。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("knowledge_promotion_merge", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runPromotionMergeSweep();
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // 巡回の失敗でpollerを止めない
    console.error("[POST /api/knowledge/promotion-merge-sweep]", error);
    return NextResponse.json(
      { error: "sweep_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
