import { NextResponse, type NextRequest } from "next/server";

import { authorizeVpsMemoryWrite } from "@/lib/vps-memory/auth";
import { MAX_SAMPLES_PER_REQUEST, parseSample } from "@/lib/vps-memory/sample";
import { saveSamples } from "@/lib/vps-memory/store";

/**
 * サブPCの`scripts/vps-memory-probe.mjs`が計測結果を送る受け口（#4256）。認証は`DISPATCH_SECRET`。
 * 1件でも不正なら全体を弾く（部分的に取り込んで取りこぼしを隠さない）。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeVpsMemoryWrite(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth !== "ok") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const raw = typeof body === "object" && body !== null ? (body as { samples?: unknown }).samples : null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SAMPLES_PER_REQUEST) {
    return NextResponse.json({ error: "invalid_samples" }, { status: 400 });
  }
  const now = new Date();
  const parsed = raw.map((r) => parseSample(r, now));
  if (parsed.some((p) => p === null)) return NextResponse.json({ error: "invalid_sample" }, { status: 400 });

  try {
    await saveSamples(parsed as NonNullable<(typeof parsed)[number]>[], now);
    return NextResponse.json({ saved: parsed.length });
  } catch (error) {
    console.error("[POST /api/integrations/vps-memory/samples]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
