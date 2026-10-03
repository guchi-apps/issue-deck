import { NextResponse, type NextRequest } from "next/server";

import {
  APP_AI_MODEL_DEFAULT,
  APP_AI_MODEL_REASONING_DEFAULT,
  CLAUDE_LOCAL_MODEL_DEFAULT,
  CODEX_MODEL_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  DEFAULT_DISPATCH_AGENT_SETTING,
  GITHUB_ACTIONS_AGENT_DEFAULT,
  GITHUB_ACTIONS_CODEX_MODEL_DEFAULT,
  DISPATCH_FAILOVER_THRESHOLD_PERCENT_DEFAULT,
  MODEL_PICK_ENGINE_DEFAULT,
  PLAN_REVIEW_AGENT_FOR_CLAUDE_DEFAULT,
  PLAN_REVIEW_AGENT_FOR_CODEX_DEFAULT,
  PLAN_REVIEW_CLAUDE_MODEL_DEFAULT,
  PLAN_REVIEW_CODEX_MODEL_DEFAULT,
  parseAppAiModel,
  parseClaudeLocalModel,
  parseClaudeLocalModelSetting,
  parseClaudeModel,
  parseCodexLocalModel,
  parseCodexModelSetting,
  parseCodexModel,
  parseCodexReasoningEffort,
  parseDefaultDispatchAgent,
  parseGithubActionsAgent,
  parseDispatchFailoverThresholdPercent,
  parseModelPickEngine,
  parsePlanReviewAgent,
} from "@/lib/app-settings";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

async function getClaudeModels() {
  const setting = (await db.appSetting.findUnique({ where: { id: 1 } })) as
    | ({ claudeLocalModel?: string } & Awaited<ReturnType<typeof db.appSetting.findUnique>>)
    | null;
  return {
    claudeModel: setting?.claudeModel ?? "auto",
    githubActionsAgent:
      parseGithubActionsAgent(setting?.githubActionsAgent) ?? GITHUB_ACTIONS_AGENT_DEFAULT,
    githubActionsCodexModel:
      parseCodexLocalModel(setting?.githubActionsCodexModel) ?? GITHUB_ACTIONS_CODEX_MODEL_DEFAULT,
    workflowClaudeModel: parseClaudeModel(setting?.workflowClaudeModel) ?? "auto",
    workflowCodexModel: parseCodexModel(setting?.workflowCodexModel) ?? "auto",
    workflowCodexReasoningEffort:
      parseCodexReasoningEffort(setting?.workflowCodexReasoningEffort) ?? CODEX_REASONING_EFFORT_DEFAULT,
    claudeModelAssist: setting?.claudeModelAssist ?? "auto",
    claudeLocalModel:
      parseClaudeLocalModelSetting(setting?.claudeLocalModel) ?? CLAUDE_LOCAL_MODEL_DEFAULT,
    codexModel: parseCodexModelSetting(setting?.codexModel) ?? CODEX_MODEL_DEFAULT,
    defaultDispatchAgent:
      parseDefaultDispatchAgent(setting?.defaultDispatchAgent) ?? DEFAULT_DISPATCH_AGENT_SETTING,
    planReviewAgentForClaude:
      parsePlanReviewAgent(setting?.planReviewAgentForClaude) ?? PLAN_REVIEW_AGENT_FOR_CLAUDE_DEFAULT,
    planReviewAgentForCodex:
      parsePlanReviewAgent(setting?.planReviewAgentForCodex) ?? PLAN_REVIEW_AGENT_FOR_CODEX_DEFAULT,
    planReviewClaudeModel:
      parseClaudeLocalModel(setting?.planReviewClaudeModel) ?? PLAN_REVIEW_CLAUDE_MODEL_DEFAULT,
    planReviewCodexModel:
      parseCodexLocalModel(setting?.planReviewCodexModel) ?? PLAN_REVIEW_CODEX_MODEL_DEFAULT,
    dispatchFailoverEnabled: setting?.dispatchFailoverEnabled ?? true,
    dispatchFailoverThresholdPercent:
      parseDispatchFailoverThresholdPercent(setting?.dispatchFailoverThresholdPercent) ??
      DISPATCH_FAILOVER_THRESHOLD_PERCENT_DEFAULT,
    appAiModel: parseAppAiModel(setting?.appAiModel) ?? APP_AI_MODEL_DEFAULT,
    appAiModelReasoning:
      parseAppAiModel(setting?.appAiModelReasoning) ?? APP_AI_MODEL_REASONING_DEFAULT,
    modelPickEngine: parseModelPickEngine(setting?.modelPickEngine) ?? MODEL_PICK_ENGINE_DEFAULT,
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
  const hasGithubActionsAgent = payload !== null && typeof payload === "object" && "githubActionsAgent" in payload;
  const githubActionsAgent = hasGithubActionsAgent
    ? parseGithubActionsAgent(payload?.githubActionsAgent)
    : undefined;
  if (hasGithubActionsAgent && githubActionsAgent === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasGithubActionsCodexModel =
    payload !== null && typeof payload === "object" && "githubActionsCodexModel" in payload;
  const githubActionsCodexModel = hasGithubActionsCodexModel
    ? parseCodexLocalModel(payload?.githubActionsCodexModel)
    : undefined;
  if (hasGithubActionsCodexModel && githubActionsCodexModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasWorkflowClaudeModel = payload !== null && typeof payload === "object" && "workflowClaudeModel" in payload;
  const workflowClaudeModel = hasWorkflowClaudeModel ? parseClaudeModel(payload?.workflowClaudeModel) : undefined;
  if (hasWorkflowClaudeModel && workflowClaudeModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasWorkflowCodexModel = payload !== null && typeof payload === "object" && "workflowCodexModel" in payload;
  const workflowCodexModel = hasWorkflowCodexModel ? parseCodexModel(payload?.workflowCodexModel) : undefined;
  if (hasWorkflowCodexModel && workflowCodexModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasWorkflowCodexReasoningEffort = payload !== null && typeof payload === "object" && "workflowCodexReasoningEffort" in payload;
  const workflowCodexReasoningEffort = hasWorkflowCodexReasoningEffort
    ? parseCodexReasoningEffort(payload?.workflowCodexReasoningEffort)
    : undefined;
  if (hasWorkflowCodexReasoningEffort && workflowCodexReasoningEffort === null) {
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
  const codexModel = hasCodex ? parseCodexModelSetting(payload?.codexModel) : undefined;
  if (hasCodex && codexModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasClaudeLocal =
    payload !== null && typeof payload === "object" && "claudeLocalModel" in payload;
  const claudeLocalModel = hasClaudeLocal
    ? parseClaudeLocalModelSetting(payload?.claudeLocalModel)
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
  const hasModelPickEngine =
    payload !== null && typeof payload === "object" && "modelPickEngine" in payload;
  const modelPickEngine = hasModelPickEngine
    ? parseModelPickEngine(payload?.modelPickEngine)
    : undefined;
  if (hasModelPickEngine && modelPickEngine === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasDefaultDispatchAgent =
    payload !== null && typeof payload === "object" && "defaultDispatchAgent" in payload;
  const defaultDispatchAgent = hasDefaultDispatchAgent
    ? parseDefaultDispatchAgent(payload?.defaultDispatchAgent)
    : undefined;
  if (hasDefaultDispatchAgent && defaultDispatchAgent === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasPlanReviewAgentForClaude =
    payload !== null && typeof payload === "object" && "planReviewAgentForClaude" in payload;
  const planReviewAgentForClaude = hasPlanReviewAgentForClaude
    ? parsePlanReviewAgent(payload?.planReviewAgentForClaude)
    : undefined;
  if (hasPlanReviewAgentForClaude && planReviewAgentForClaude === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasPlanReviewAgentForCodex =
    payload !== null && typeof payload === "object" && "planReviewAgentForCodex" in payload;
  const planReviewAgentForCodex = hasPlanReviewAgentForCodex
    ? parsePlanReviewAgent(payload?.planReviewAgentForCodex)
    : undefined;
  if (hasPlanReviewAgentForCodex && planReviewAgentForCodex === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasPlanReviewClaudeModel =
    payload !== null && typeof payload === "object" && "planReviewClaudeModel" in payload;
  const planReviewClaudeModel = hasPlanReviewClaudeModel
    ? parseClaudeLocalModel(payload?.planReviewClaudeModel)
    : undefined;
  if (hasPlanReviewClaudeModel && planReviewClaudeModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasPlanReviewCodexModel =
    payload !== null && typeof payload === "object" && "planReviewCodexModel" in payload;
  const planReviewCodexModel = hasPlanReviewCodexModel
    ? parseCodexLocalModel(payload?.planReviewCodexModel)
    : undefined;
  if (hasPlanReviewCodexModel && planReviewCodexModel === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasDispatchFailoverEnabled =
    payload !== null && typeof payload === "object" && "dispatchFailoverEnabled" in payload;
  const dispatchFailoverEnabled = hasDispatchFailoverEnabled ? payload?.dispatchFailoverEnabled : undefined;
  if (hasDispatchFailoverEnabled && typeof dispatchFailoverEnabled !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const hasDispatchFailoverThreshold =
    payload !== null && typeof payload === "object" && "dispatchFailoverThresholdPercent" in payload;
  const dispatchFailoverThresholdPercent = hasDispatchFailoverThreshold
    ? parseDispatchFailoverThresholdPercent(payload?.dispatchFailoverThresholdPercent)
    : undefined;
  if (hasDispatchFailoverThreshold && dispatchFailoverThresholdPercent === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const validDispatchFailoverThresholdPercent =
    dispatchFailoverThresholdPercent === null ? undefined : dispatchFailoverThresholdPercent;

  const updated = (await db.appSetting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      claudeModel,
      ...(githubActionsAgent ? { githubActionsAgent } : {}),
      ...(githubActionsCodexModel ? { githubActionsCodexModel } : {}),
      ...(workflowClaudeModel ? { workflowClaudeModel } : {}),
      ...(workflowCodexModel ? { workflowCodexModel } : {}),
      ...(workflowCodexReasoningEffort ? { workflowCodexReasoningEffort } : {}),
      ...(claudeModelAssist ? { claudeModelAssist } : {}),
      ...(codexModel ? { codexModel } : {}),
      ...(claudeLocalModel ? { claudeLocalModel } : {}),
      ...(appAiModel ? { appAiModel } : {}),
      ...(appAiModelReasoning ? { appAiModelReasoning } : {}),
      ...(modelPickEngine ? { modelPickEngine } : {}),
      ...(defaultDispatchAgent ? { defaultDispatchAgent } : {}),
      ...(planReviewAgentForClaude ? { planReviewAgentForClaude } : {}),
      ...(planReviewAgentForCodex ? { planReviewAgentForCodex } : {}),
      ...(planReviewClaudeModel ? { planReviewClaudeModel } : {}),
      ...(planReviewCodexModel ? { planReviewCodexModel } : {}),
      ...(dispatchFailoverEnabled !== undefined ? { dispatchFailoverEnabled } : {}),
      ...(validDispatchFailoverThresholdPercent !== undefined
        ? { dispatchFailoverThresholdPercent: validDispatchFailoverThresholdPercent }
        : {}),
    },
    update: {
      claudeModel,
      ...(githubActionsAgent ? { githubActionsAgent } : {}),
      ...(githubActionsCodexModel ? { githubActionsCodexModel } : {}),
      ...(workflowClaudeModel ? { workflowClaudeModel } : {}),
      ...(workflowCodexModel ? { workflowCodexModel } : {}),
      ...(workflowCodexReasoningEffort ? { workflowCodexReasoningEffort } : {}),
      ...(claudeModelAssist ? { claudeModelAssist } : {}),
      ...(codexModel ? { codexModel } : {}),
      ...(claudeLocalModel ? { claudeLocalModel } : {}),
      ...(appAiModel ? { appAiModel } : {}),
      ...(appAiModelReasoning ? { appAiModelReasoning } : {}),
      ...(modelPickEngine ? { modelPickEngine } : {}),
      ...(defaultDispatchAgent ? { defaultDispatchAgent } : {}),
      ...(planReviewAgentForClaude ? { planReviewAgentForClaude } : {}),
      ...(planReviewAgentForCodex ? { planReviewAgentForCodex } : {}),
      ...(planReviewClaudeModel ? { planReviewClaudeModel } : {}),
      ...(planReviewCodexModel ? { planReviewCodexModel } : {}),
      ...(dispatchFailoverEnabled !== undefined ? { dispatchFailoverEnabled } : {}),
      ...(validDispatchFailoverThresholdPercent !== undefined
        ? { dispatchFailoverThresholdPercent: validDispatchFailoverThresholdPercent }
        : {}),
    },
  })) as Awaited<ReturnType<typeof db.appSetting.upsert>> & {
    claudeLocalModel?: string;
    defaultDispatchAgent?: string;
    planReviewAgentForClaude?: string;
    planReviewAgentForCodex?: string;
    planReviewClaudeModel?: string;
    planReviewCodexModel?: string;
    dispatchFailoverEnabled?: boolean;
    dispatchFailoverThresholdPercent?: number;
  };

  return NextResponse.json({
    claudeModel: updated.claudeModel,
    githubActionsAgent:
      parseGithubActionsAgent(updated.githubActionsAgent) ?? GITHUB_ACTIONS_AGENT_DEFAULT,
    githubActionsCodexModel:
      parseCodexLocalModel(updated.githubActionsCodexModel) ?? GITHUB_ACTIONS_CODEX_MODEL_DEFAULT,
    workflowClaudeModel: parseClaudeModel(updated.workflowClaudeModel) ?? "auto",
    workflowCodexModel: parseCodexModel(updated.workflowCodexModel) ?? "auto",
    workflowCodexReasoningEffort:
      parseCodexReasoningEffort(updated.workflowCodexReasoningEffort) ?? CODEX_REASONING_EFFORT_DEFAULT,
    claudeModelAssist: updated.claudeModelAssist,
    codexModel: parseCodexModelSetting(updated.codexModel) ?? CODEX_MODEL_DEFAULT,
    claudeLocalModel:
      parseClaudeLocalModelSetting(updated.claudeLocalModel) ?? CLAUDE_LOCAL_MODEL_DEFAULT,
    appAiModel: parseAppAiModel(updated.appAiModel) ?? APP_AI_MODEL_DEFAULT,
    appAiModelReasoning:
      parseAppAiModel(updated.appAiModelReasoning) ?? APP_AI_MODEL_REASONING_DEFAULT,
    modelPickEngine: parseModelPickEngine(updated.modelPickEngine) ?? MODEL_PICK_ENGINE_DEFAULT,
    defaultDispatchAgent:
      parseDefaultDispatchAgent(updated.defaultDispatchAgent) ?? DEFAULT_DISPATCH_AGENT_SETTING,
    planReviewAgentForClaude:
      parsePlanReviewAgent(updated.planReviewAgentForClaude) ?? PLAN_REVIEW_AGENT_FOR_CLAUDE_DEFAULT,
    planReviewAgentForCodex:
      parsePlanReviewAgent(updated.planReviewAgentForCodex) ?? PLAN_REVIEW_AGENT_FOR_CODEX_DEFAULT,
    planReviewClaudeModel:
      parseClaudeLocalModel(updated.planReviewClaudeModel) ?? PLAN_REVIEW_CLAUDE_MODEL_DEFAULT,
    planReviewCodexModel:
      parseCodexLocalModel(updated.planReviewCodexModel) ?? PLAN_REVIEW_CODEX_MODEL_DEFAULT,
    dispatchFailoverEnabled: updated.dispatchFailoverEnabled ?? true,
    dispatchFailoverThresholdPercent:
      parseDispatchFailoverThresholdPercent(updated.dispatchFailoverThresholdPercent) ??
      DISPATCH_FAILOVER_THRESHOLD_PERCENT_DEFAULT,
  });
}
