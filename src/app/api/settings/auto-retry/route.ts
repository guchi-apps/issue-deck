import { NextResponse, type NextRequest } from "next/server";

import { AUTO_RETRY_LIMIT_MIN, parseAutoRetryLimit } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

async function getAutoRetryLimit() {
  const setting = await db.appSetting.findUnique({ where: { id: 1 } });
  return setting?.autoRetryLimit ?? AUTO_RETRY_LIMIT_MIN;
}

/**
 * GitHub Actions（認証済みセッション無し）から自動リトライ回数の上限を参照するための
 * 読み取り専用API。全リポジトリ共通の設定のため、リポジトリを特定するパラメータは無い（#497）。
 */
export async function GET() {
  const autoRetryLimit = await getAutoRetryLimit();
  return NextResponse.json({ autoRetryLimit }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const autoRetryLimit = parseAutoRetryLimit(payload?.autoRetryLimit);
  if (autoRetryLimit === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, autoRetryLimit },
    update: { autoRetryLimit },
  });

  return NextResponse.json({ autoRetryLimit: updated.autoRetryLimit });
}
