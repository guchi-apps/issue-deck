import { NextResponse, type NextRequest } from "next/server";

import { parseClaudeModel } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

async function getClaudeModel() {
  const setting = await db.appSetting.findUnique({ where: { id: 1 } });
  return setting?.claudeModel ?? "auto";
}

/**
 * GitHub Actions（認証済みセッション無し）からClaude Code Action起動時の--modelに使う値を
 * 参照するための読み取り専用API。全リポジトリ共通の設定のため、リポジトリを特定する
 * パラメータは無い（#622、#497のauto-retryと同じ方針）。
 */
export async function GET() {
  const claudeModel = await getClaudeModel();
  return NextResponse.json({ claudeModel }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const claudeModel = parseClaudeModel(payload?.claudeModel);
  if (claudeModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, claudeModel },
    update: { claudeModel },
  });

  return NextResponse.json({ claudeModel: updated.claudeModel });
}
