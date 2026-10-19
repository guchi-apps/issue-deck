import { NextResponse, type NextRequest } from "next/server";

import { fetchClaudeUsage, peekClaudeUsage } from "@/lib/claude/usage";
import { getCodexUsage } from "@/lib/dispatch/codex-usage";
import { authenticateShareToken } from "@/lib/share-token/auth";
import {
  isClaudeFiveHourWindowActive,
  toClaudeWidgetWindow,
  toCodexWidgetWindow,
  type WidgetUsageResponse,
} from "@/lib/widget-usage";

/**
 * iOSロック画面ウィジェット（#4890）が読む、ClaudeとChatGPT（Codex）の週間枠。**共有トークンで呼ぶ。**
 * ウィジェットはアプリのログインCookieを持たないため、共有メニュー（#4298）と同じトークンを使う。
 *
 * Claudeの値は探り（推論1回）でしか取れず、送信が5時間枠を開始する。ウィジェットの更新だけで
 * 枠を始めないよう、取り直すのは5時間枠が動いている間だけにし、それ以外は最後に見た値を返す。
 */
export async function GET(request: NextRequest) {
  const user = await authenticateShareToken(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = Date.now();
  const [claude, chatgpt] = await Promise.all([readClaude(now), getCodexUsage().catch(() => null)]);

  const body: WidgetUsageResponse = {
    claude: toClaudeWidgetWindow(claude, now),
    chatgpt: toCodexWidgetWindow(chatgpt),
    generatedAt: now,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

async function readClaude(now: number) {
  const cached = peekClaudeUsage();
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token || !cached || !isClaudeFiveHourWindowActive(cached.windows, now)) return cached;
  try {
    return await fetchClaudeUsage(token);
  } catch {
    return cached;
  }
}
