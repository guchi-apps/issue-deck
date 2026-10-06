import {
  APP_AI_MODEL_OPTIONS,
  CODEX_MODEL_DEFAULT,
  MODEL_PICK_SETTING,
  describeClaudeModel,
  describeCodexModel,
  type AppAiModel,
  type ClaudeLocalModel,
  type ClaudeLocalModelSetting,
  type ClaudeModel,
  type CodexLocalModel,
  type CodexModel,
  type CodexModelSetting,
  type CodexReasoningEffort,
  type GithubActionsAgent,
  type ModelPickEngine,
  type PlanReviewAgent,
} from "@/lib/app-settings";

/** 設定画面が表示する、利用者の処理単位の実行経路。実行側の既定値は app-settings の定数から読む。 */
export type ExecutionFlow = {
  group: "計画" | "実装" | "レビュー" | "修復" | "アプリ内AI" | "判定";
  name: string;
  location: string;
  agent: string;
  model: string;
  source: string;
  sourceId?: string;
  setting?: string;
  reasoningEffort?: string;
  note?: string;
};

export type ExecutionFlowSettings = {
  claudeModel: ClaudeModel;
  githubActionsAgent: GithubActionsAgent;
  githubActionsCodexModel: CodexLocalModel;
  workflowClaudeModel?: ClaudeModel;
  workflowCodexModel?: CodexModel;
  workflowCodexReasoningEffort?: CodexReasoningEffort;
  claudeModelAssist: ClaudeModel;
  claudeLocalModel: ClaudeLocalModelSetting;
  codexModel: CodexModelSetting;
  planReviewAgentForClaude: PlanReviewAgent;
  planReviewAgentForCodex: PlanReviewAgent;
  planReviewClaudeModel: ClaudeLocalModel;
  planReviewCodexModel: CodexLocalModel;
  appAiModel: AppAiModel;
  appAiModelReasoning: AppAiModel;
  modelPickEngine: ModelPickEngine;
};

function appAiModelLabel(model: AppAiModel) {
  return APP_AI_MODEL_OPTIONS.find((option) => option.value === model)?.label ?? model;
}

function actionsAgent(settings: ExecutionFlowSettings) {
  return settings.githubActionsAgent === "codex" ? "Codex Action" : "Claude Code";
}

function actionsModel(settings: ExecutionFlowSettings) {
  return settings.githubActionsAgent === "codex"
    ? describeCodexModel(settings.githubActionsCodexModel)
    : describeClaudeModel(settings.claudeModel);
}

function localModel(setting: ClaudeLocalModelSetting | CodexModelSetting, agent: PlanReviewAgent) {
  if (setting === MODEL_PICK_SETTING) {
    return agent === "claude"
      ? "おまかせ（実装開始時に判定）"
      : "おまかせ（実装開始時に判定）";
  }
  return agent === "claude"
    ? describeClaudeModel(setting as ClaudeModel)
    : describeCodexModel(setting as never);
}

function planReviewModel(settings: ExecutionFlowSettings, agent: PlanReviewAgent) {
  return agent === "claude"
    ? describeClaudeModel(settings.planReviewClaudeModel)
    : describeCodexModel(settings.planReviewCodexModel);
}

/**
 * 画面専用の文言を各フォームへ散らさず、保存前の値から現在の実効設定を組み立てる。
 * Actions の修復系はモデル入力を受け取らないため、CLI の既定と明示して推測表示を避ける。
 */
export function resolveExecutionFlows(settings: ExecutionFlowSettings): ExecutionFlow[] {
  const workflowClaudeModel = settings.workflowClaudeModel ?? "auto";
  const workflowCodexModel = settings.workflowCodexModel ?? "auto";
  const workflowCodexReasoningEffort = settings.workflowCodexReasoningEffort ?? "default";
  const localClaudeNote = settings.claudeLocalModel === MODEL_PICK_SETTING
    ? `候補: Sonnet 5.5 / Opus 5.5 / Fable 5.1。ダイアログを経由しない起動は ${describeClaudeModel("sonnet")} にフォールバックします。`
    : undefined;
  const localCodexNote = settings.codexModel === MODEL_PICK_SETTING
    ? `候補: GPT-6 Astra / GPT-6 Sol / GPT-5.6 Terra / GPT-6 Luna。ダイアログを経由しない起動は ${describeCodexModel(CODEX_MODEL_DEFAULT)} にフォールバックします。`
    : undefined;
  const actionFlow = (name: string): ExecutionFlow => ({
    group: "計画",
    name,
    location: "GitHub Actions",
    agent: actionsAgent(settings),
    model: actionsModel(settings),
    source: "GitHub Actions 共通設定",
    sourceId: "github-actions-settings",
  });

  return [
    actionFlow("計画作成（無人実行）"),
    {
      group: "計画", name: "計画作成（サブPC）", location: "サブPC", agent: "Claude Code",
      model: localModel(settings.claudeLocalModel, "claude"), source: "サブPC Claude 設定", sourceId: "subpc-model-settings", note: localClaudeNote,
    },
    {
      group: "計画", name: "計画作成（サブPC）", location: "サブPC", agent: "Codex CLI",
      model: localModel(settings.codexModel, "codex"), source: "サブPC Codex 設定", sourceId: "subpc-model-settings", note: localCodexNote,
    },
    ...(["Claude Codeで開始後", "Codex CLIで開始後"] as const).map((name, index) => {
      const agent = index === 0 ? settings.planReviewAgentForClaude : settings.planReviewAgentForCodex;
      return {
        group: "計画" as const, name: `自動計画レビュー（${name}）`, location: "サブPC",
        agent: agent === "claude" ? "Claude Code" : "Codex CLI", model: planReviewModel(settings, agent),
        source: "計画レビュー設定", sourceId: "plan-review-settings",
      };
    }),
    {
      group: "実装", name: "通常実装・追加修正（無人実行）", location: "GitHub Actions",
      agent: actionsAgent(settings), model: actionsModel(settings), source: "GitHub Actions 共通設定", sourceId: "github-actions-settings",
    },
    {
      group: "実装", name: "通常実装・セッション継続（Claude）", location: "サブPC", agent: "Claude Code",
      model: localModel(settings.claudeLocalModel, "claude"), source: "サブPC Claude 設定", sourceId: "subpc-model-settings", note: localClaudeNote,
    },
    {
      group: "実装", name: "通常実装・セッション継続（Codex）", location: "サブPC", agent: "Codex CLI",
      model: localModel(settings.codexModel, "codex"), source: "サブPC Codex 設定", sourceId: "subpc-model-settings", note: localCodexNote,
    },
    {
      group: "実装", name: "質問回答・Issue分割", location: "GitHub Actions", agent: actionsAgent(settings),
      model: settings.githubActionsAgent === "codex" ? actionsModel(settings) : describeClaudeModel(settings.claudeModelAssist),
      source: settings.githubActionsAgent === "codex" ? "GitHub Actions 共通設定" : "質問・Issue分割設定", sourceId: "github-actions-settings",
    },
    {
      group: "レビュー", name: "PRコードレビュー（Claude）", location: "GitHub Actions", agent: "Claude Code",
      model: describeClaudeModel(workflowClaudeModel), source: "PRレビュー・修復設定", setting: workflowClaudeModel === "auto" ? "デフォルト継承" : describeClaudeModel(workflowClaudeModel), sourceId: "workflow-model-settings",
    },
    {
      group: "レビュー", name: "PRコードレビュー（Codex）", location: "サブPC", agent: "Codex CLI",
      model: describeCodexModel(workflowCodexModel), source: "PRレビュー・修復設定", setting: workflowCodexModel === "auto" ? "デフォルト継承" : describeCodexModel(workflowCodexModel), reasoningEffort: workflowCodexReasoningEffort === "default" ? "デフォルト継承" : workflowCodexReasoningEffort, sourceId: "workflow-model-settings",
    },
    {
      group: "修復", name: "レビュー指摘修正（Claude）・CI自動修正・コンフリクト解消・PR repair", location: "GitHub Actions", agent: "Claude Code",
      model: describeClaudeModel(workflowClaudeModel), source: "PRレビュー・修復設定", setting: workflowClaudeModel === "auto" ? "デフォルト継承" : describeClaudeModel(workflowClaudeModel), sourceId: "workflow-model-settings", note: "Claude実装のレビュー指摘修正と、CI自動修正・コンフリクト解消・PR repairで共有します。",
    },
    {
      group: "修復", name: "レビュー指摘修正（Codex）", location: "サブPC", agent: "Codex CLI",
      model: describeCodexModel(workflowCodexModel), source: "PRレビュー・修復設定", setting: workflowCodexModel === "auto" ? "デフォルト継承" : describeCodexModel(workflowCodexModel), reasoningEffort: workflowCodexReasoningEffort === "default" ? "デフォルト継承" : workflowCodexReasoningEffort, sourceId: "workflow-model-settings", note: "Codexで実装したIssueのレビュー指摘を、サブPCのChatGPT購読認証で修正します。APIキーは不要です。",
    },
    {
      group: "アプリ内AI", name: "要約・検索・文章整理・手作業アシスタント", location: "IssueDeckサーバー",
      agent: "Anthropic API / OpenAI API", model: appAiModelLabel(settings.appAiModel), source: "アプリ内AI設定", sourceId: "app-ai-settings",
    },
    {
      group: "アプリ内AI", name: "原因診断・新規アプリ相談", location: "IssueDeckサーバー",
      agent: "Anthropic API / OpenAI API", model: appAiModelLabel(settings.appAiModelReasoning), source: "アプリ内AI（推論）設定", sourceId: "app-ai-settings",
    },
    {
      group: "判定", name: "おまかせのモデル選択・Issueラベル判定", location: settings.modelPickEngine === "jev" ? "TypeSafe" : "IssueDeckサーバー",
      agent: settings.modelPickEngine === "jev" ? "Jev" : "Anthropic API / OpenAI API", model: settings.modelPickEngine === "jev" ? "Jev（候補から判定）" : appAiModelLabel(settings.appAiModel),
      source: "判定に使うAI設定", sourceId: "model-pick-settings", note: settings.modelPickEngine === "jev" ? "Jevが利用できない場合はアプリ内AIで判定します。" : undefined,
    },
  ];
}
