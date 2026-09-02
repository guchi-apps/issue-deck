import { NextResponse, type NextRequest } from "next/server";

import {
  APP_AI_MODEL_DEFAULT,
  APP_AI_MODEL_REASONING_DEFAULT,
  CLAUDE_LOCAL_MODEL_DEFAULT,
  CODEX_MODEL_DEFAULT,
  parseAppAiModel,
  parseClaudeLocalModel,
  parseClaudeModel,
  parseCodexModel,
} from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

async function getClaudeModels() {
  const setting = (await db.appSetting.findUnique({ where: { id: 1 } })) as
    | ({ claudeLocalModel?: string } & Awaited<ReturnType<typeof db.appSetting.findUnique>>)
    | null;
  return {
    claudeModel: setting?.claudeModel ?? "auto",
    claudeModelAssist: setting?.claudeModelAssist ?? "auto",
    claudeLocalModel:
      parseClaudeLocalModel(setting?.claudeLocalModel) ?? CLAUDE_LOCAL_MODEL_DEFAULT,
    codexModel: setting?.codexModel ?? CODEX_MODEL_DEFAULT,
    appAiModel: parseAppAiModel(setting?.appAiModel) ?? APP_AI_MODEL_DEFAULT,
    appAiModelReasoning:
      parseAppAiModel(setting?.appAiModelReasoning) ?? APP_AI_MODEL_REASONING_DEFAULT,
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
  const hasCodex = payload !== null && typeof payload === "object" && "codexModel" in payload;
  const codexModel = hasCodex ? parseCodexModel(payload?.codexModel) : undefined;
  if (hasCodex && codexModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasClaudeLocal =
    payload !== null && typeof payload === "object" && "claudeLocalModel" in payload;
  const claudeLocalModel = hasClaudeLocal
    ? parseClaudeLocalModel(payload?.claudeLocalModel)
    : undefined;
  if (hasClaudeLocal && claudeLocalModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasAppAi = payload !== null && typeof payload === "object" && "appAiModel" in payload;
  const appAiModel = hasAppAi ? parseAppAiModel(payload?.appAiModel) : undefined;
  if (hasAppAi && appAiModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasAppAiReasoning =
    payload !== null && typeof payload === "object" && "appAiModelReasoning" in payload;
  const appAiModelReasoning = hasAppAiReasoning
    ? parseAppAiModel(payload?.appAiModelReasoning)
    : undefined;
  if (hasAppAiReasoning && appAiModelReasoning === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const updated = (await db.appSetting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      claudeModel,
      ...(claudeModelAssist ? { claudeModelAssist } : {}),
      ...(codexModel ? { codexModel } : {}),
      ...(claudeLocalModel ? { claudeLocalModel } : {}),
      ...(appAiModel ? { appAiModel } : {}),
      ...(appAiModelReasoning ? { appAiModelReasoning } : {}),
    },
    update: {
      claudeModel,
      ...(claudeModelAssist ? { claudeModelAssist } : {}),
      ...(codexModel ? { codexModel } : {}),
      ...(claudeLocalModel ? { claudeLocalModel } : {}),
      ...(appAiModel ? { appAiModel } : {}),
      ...(appAiModelReasoning ? { appAiModelReasoning } : {}),
    },
  })) as Awaited<ReturnType<typeof db.appSetting.upsert>> & { claudeLocalModel?: string };

  return NextResponse.json({
    claudeModel: updated.claudeModel,
    claudeModelAssist: updated.claudeModelAssist,
    codexModel: updated.codexModel,
    claudeLocalModel:
      parseClaudeLocalModel(updated.claudeLocalModel) ?? CLAUDE_LOCAL_MODEL_DEFAULT,
    appAiModel: parseAppAiModel(updated.appAiModel) ?? APP_AI_MODEL_DEFAULT,
    appAiModelReasoning:
      parseAppAiModel(updated.appAiModelReasoning) ?? APP_AI_MODEL_REASONING_DEFAULT,
  });
}
