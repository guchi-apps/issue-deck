import { NextResponse, type NextRequest } from "next/server";

import { handleCircleciWebhook } from "@/lib/backup-ci/service";

/**
 * CircleCIのOutbound Webhook（`workflow-completed`）の受け口（#4065）。
 *
 * **署名（`circleci-signature`）を検証してから処理し、イベントIDで重複を除く。** 本文の状態は
 * 合否に使わず、該当する実行をCircleCI APIで照合し直す（偽のWebhookで合格を作れないように）。
 * 処理に失敗したら500を返し、CircleCIの再送に任せる。Webhookが届かなくても、pollerの巡回が
 * 同じ照合を行う。
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  try {
    const outcome = await handleCircleciWebhook(rawBody, request.headers.get("circleci-signature"));
    switch (outcome.kind) {
      case "not_configured":
        return NextResponse.json({ error: "not_configured" }, { status: 503 });
      case "unauthorized":
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      case "invalid":
        return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
      default:
        return NextResponse.json({ ok: true, ...outcome });
    }
  } catch (error) {
    console.error("[POST /api/webhooks/circleci]", error);
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}
