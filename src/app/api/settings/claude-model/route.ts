import { NextResponse, type NextRequest } from "next/server";

import { parseClaudeModel } from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

async function getClaudeModels() {
  const setting = await db.appSetting.findUnique({ where: { id: 1 } });
  return {
    claudeModel: setting?.claudeModel ?? "auto",
    claudeModelAssist: setting?.claudeModelAssist ?? "auto",
  };
}

/**
 * GitHub Actions（認証済みセッション無し）からClaude Code Action起動時の--modelに使う値を
 * 参照するための読み取り専用API。全リポジトリ共通の設定のため、リポジトリを特定する
 * パラメータは無い（#622、#497のauto-retryと同じ方針）。
 *
 * claudeModelが実装・計画用、claudeModelAssistが質問応答・サブIssue分割のような補助処理用
 * （#905）。実装と補助では品質要求が異なり、同じモデルで動かすとコストに見合わないため分けている。
 */
export async function GET() {
  const models = await getClaudeModels();
  return NextResponse.json(models, { headers: { "Cache-Control": "no-store" } });
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
  // claudeModelAssistは省略を許容し、その場合は既存値を変更しない。設定画面は常に両方を送るが、
  // 片方だけ更新したい呼び出し（および本APIの旧形式のリクエスト）を壊さないため。
  const hasAssist = payload !== null && typeof payload === "object" && "claudeModelAssist" in payload;
  const claudeModelAssist = hasAssist ? parseClaudeModel(payload?.claudeModelAssist) : undefined;
  if (hasAssist && claudeModelAssist === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = await db.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, claudeModel, ...(claudeModelAssist ? { claudeModelAssist } : {}) },
    update: { claudeModel, ...(claudeModelAssist ? { claudeModelAssist } : {}) },
  });

  return NextResponse.json({
    claudeModel: updated.claudeModel,
    claudeModelAssist: updated.claudeModelAssist,
  });
}
