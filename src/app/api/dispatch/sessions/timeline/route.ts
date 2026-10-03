import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";
import { parseSessionTimelineEvents, replaceSessionTimeline } from "@/lib/dispatch/session-timeline";

export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: auth }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: auth }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const host = parseDispatchHostName(payload?.host);
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : null;
  const events = parseSessionTimelineEvents(payload?.events);
  if (!host || !sessionId || !events) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const updated = await replaceSessionTimeline({ sessionId, host, events });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
