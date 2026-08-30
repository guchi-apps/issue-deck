import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { runManualImageCleanup } from "@/lib/images/image-cleanup-run";
import { previewModeGuard } from "@/lib/preview-mode";

const MODES = ["trash-unused", "empty-trash"] as const;
type CleanupMode = (typeof MODES)[number];

function parseMode(value: unknown): CleanupMode | null {
  if (typeof value !== "string") return null;
  return (MODES as readonly string[]).includes(value) ? (value as CleanupMode) : null;
}

/**
 * 画面から押す一括操作（#2475）。ログイン必須。
 *
 * - `trash-unused` … 参照が見つからず保持期間を過ぎた画像をまとめてゴミ箱へ移す
 * - `empty-trash` … ゴミ箱を空にする（**ここから先は戻せない**）
 *
 * **未使用の判定は巡回とまったく同じものを使う。** 人が押したときだけ条件を緩めると、
 * 画面で消したものと巡回が消すものが食い違い、「画面からは消せたのに巡回は消さない」が起きる。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const mode = parseMode(payload?.mode);
  if (mode === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const result = await runManualImageCleanup(mode);
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[POST /api/issues/images/cleanup]", error);
    return NextResponse.json({ error: "cleanup_failed" }, { status: 500 });
  }
}
