import { NextResponse, type NextRequest } from "next/server";

import { fetchChatTurnRequest, reportChatTurnResult } from "@/lib/chat/codex-turn-report";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName } from "@/lib/dispatch/dispatch-job";

/**
 * チャット相談のモデル呼び出し（`CHAT_TURN`・#4109）の受け渡し。呼ぶのはサブPCの
 * `scripts/run-chat-codex.sh`だけで、認証はpollerと同じ`DISPATCH_SECRET`。
 */
function json(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { "Cache-Control": "no-store", ...init?.headers } });
}

function authorize(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return json({ error: "unauthorized" }, { status: 401 });
  return null;
}

const JOB_ID = /^[a-z0-9]{8,32}$/;

/** プロンプトを受け取る（`?jobId=…&host=…`） */
export async function GET(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;
  const jobId = request.nextUrl.searchParams.get("jobId") ?? "";
  const host = parseDispatchHostName(request.nextUrl.searchParams.get("host"));
  if (!JOB_ID.test(jobId) || !host) return json({ error: "invalid_request" }, { status: 400 });

  const result = await fetchChatTurnRequest({ jobId, host });
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  return json(result.body);
}

/** 結果を返す（`{jobId, host, status, output?, errorKind?, usage?}`） */
export async function POST(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;
  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const jobId = typeof payload?.jobId === "string" ? payload.jobId : "";
  const host = parseDispatchHostName(payload?.host);
  const status = payload?.status === "succeeded" || payload?.status === "failed" ? payload.status : null;
  if (!JOB_ID.test(jobId) || !host || !status) return json({ error: "invalid_request" }, { status: 400 });

  const result = await reportChatTurnResult({
    jobId,
    host,
    status,
    output: typeof payload?.output === "string" ? payload.output : null,
    errorKind: payload?.errorKind,
    usage: payload?.usage,
    timing: payload?.timing,
  });
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  return json({ ok: true });
}
