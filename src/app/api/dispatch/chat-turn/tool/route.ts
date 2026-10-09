import { NextResponse, type NextRequest } from "next/server";

import { runChatTurnTool } from "@/lib/chat/codex-turn-report";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";

/**
 * Codexが1回の起動の中で呼ぶ読み取りツール（#4199）。呼ぶのはサブPCの
 * `scripts/lib/chat-tool-bridge.mjs`だけで、認証はpollerと同じ`DISPATCH_SECRET`。
 * ツールの実行・上限・機密の伏せ字はここ（サーバー）で行い、Codexは結果の文字列だけを受け取る。
 */
function json(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { "Cache-Control": "no-store", ...init?.headers } });
}

const JOB_ID = /^[a-z0-9]{8,32}$/;

export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return json({ error: "unauthorized" }, { status: 401 });

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const jobId = typeof payload?.jobId === "string" ? payload.jobId : "";
  const host = parseDispatchHostName(payload?.host);
  const name = typeof payload?.name === "string" ? payload.name.slice(0, 60) : "";
  const args =
    payload?.args && typeof payload.args === "object" && !Array.isArray(payload.args)
      ? (payload.args as Record<string, unknown>)
      : {};
  if (!JOB_ID.test(jobId) || !host || !name) return json({ error: "invalid_request" }, { status: 400 });

  const result = await runChatTurnTool({ jobId, host, name, args });
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  return json({ ok: result.result.ok, text: result.result.text });
}
