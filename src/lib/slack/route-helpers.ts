import { NextResponse, type NextRequest } from "next/server";

import { createSlackClient } from "@/lib/slack/client";
import { loadSlackConfig, type SlackConfig } from "@/lib/slack/config";
import type { IntakeContext } from "@/lib/slack/intake";
import { verifySlackSignature } from "@/lib/slack/verify";

/**
 * Slack受け口の共通の入口。**認証の代わりに、先頭で生ボディの署名を検証する**（`proxy.ts`は`/api/`を素通しする）。
 * 連携が未設定なら503、署名が不正なら401。拒否の理由は本文へ出さない。
 */
export async function authenticateSlackRequest(
  request: NextRequest,
): Promise<{ ok: true; rawBody: string; config: SlackConfig; ctx: IntakeContext } | { ok: false; response: NextResponse }> {
  const config = loadSlackConfig();
  if (!config) return { ok: false, response: NextResponse.json({ error: "slack_not_configured" }, { status: 503 }) };
  const rawBody = await request.text();
  const valid = verifySlackSignature({
    rawBody,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    signingSecret: config.signingSecret,
  });
  if (!valid) return { ok: false, response: NextResponse.json({ error: "invalid_signature" }, { status: 401 }) };
  return { ok: true, rawBody, config, ctx: { config, client: createSlackClient(config.botToken) } };
}
