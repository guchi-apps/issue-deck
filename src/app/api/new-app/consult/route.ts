import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import {
  isConsultExhausted,
  MAX_CONSULT_TURNS,
  type ConsultMessage,
} from "@/lib/claude/limits";
import {
  MAX_CONSULT_MESSAGE_LENGTH,
  continueNewAppConsult,
} from "@/lib/claude/new-app-consult";
import { getAppAiToken } from "@/lib/claude/request";

/**
 * 新規アプリの相談を1往復進める（#2188）。
 *
 * **会話の履歴はサーバーに持たない。** 画面が持っているものをそのまま送ってもらい、
 * 応答を返すだけにする（DBのモデルを増やさないための割り切りで、ウィザードを閉じたら
 * 会話も消える。仕様案は設定ステップへ引き渡した時点でIssueの本文として残る）。
 *
 * **往復数の上限をサーバー側でも見る。** 画面のボタンを無効にするだけだと、
 * 直接叩けば何往復でもプラン枠を使えてしまう。
 */

function parseMessages(value: unknown): ConsultMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const messages: ConsultMessage[] = [];
  for (const entry of value) {
    const role = (entry as { role?: unknown })?.role;
    const content = (entry as { content?: unknown })?.content;
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string") return null;
    messages.push({ role, content: content.slice(0, MAX_CONSULT_MESSAGE_LENGTH) });
  }
  return messages;
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = await getAppAiToken();
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const messages = parseMessages(payload?.messages);
  if (!messages) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (isConsultExhausted(messages)) {
    return NextResponse.json(
      { error: "consult_exhausted", maxTurns: MAX_CONSULT_TURNS },
      { status: 429 },
    );
  }

  try {
    const result = await continueNewAppConsult(token, messages);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[POST /api/new-app/consult]", error);
    return NextResponse.json(
      {
        error: "consult_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
