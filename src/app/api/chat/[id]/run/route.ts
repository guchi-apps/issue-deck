import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { loadChatRun } from "@/lib/chat/codex-run";

type Params = { params: Promise<{ id: string }> };

/**
 * 回答待ち（Codex CLI経由。#4109）の状態を返す。終わっていれば返信と会話の文脈も返す。
 * 画面は「回答中」の間、数秒おきにここを取りに来る。
 */
export async function GET(request: NextRequest, { params }: Params) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const runId = request.nextUrl.searchParams.get("runId") ?? "";
  if (!/^[a-z0-9]{8,32}$/.test(runId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const result = await loadChatRun({ conversationId: id, userId, runId });
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
