import {
  APP_AI_MODEL_OPTIONS,
  CODEX_MODEL_DEFAULT,
  appAiProvider,
  parseAppAiModel,
  parseDefaultDispatchAgent,
  resolveAppAiModel,
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
  type DefaultDispatchAgent,
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

function appAiAgent(model: AppAiModel) {
  return appAiProvider(model) === "openai" ? "OpenAI API（従量課金）" : "Anthropic API";
}

/** チャット調査はGPT系ならサブPCのCodex CLI（サブスク枠）で動く（#4143）。主系プロバイダーは見ない。 */
function chatInvestigationAgent(model: AppAiModel) {
  return appAiProvider(model) === "openai" ? "Codex CLI（ChatGPTサブスク）" : "Anthropic API";
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
      agent: appAiAgent(settings.appAiModel), model: appAiModelLabel(settings.appAiModel), source: "アプリ内AI設定", sourceId: "app-ai-settings",
    },
    {
      group: "アプリ内AI", name: "原因診断（チャット調査）",
      location: appAiProvider(settings.appAiModelReasoning) === "openai" ? "サブPC" : "IssueDeckサーバー",
      agent: chatInvestigationAgent(settings.appAiModelReasoning), model: appAiModelLabel(settings.appAiModelReasoning), source: "アプリ内AI（推論）設定", sourceId: "app-ai-settings",
      note: appAiProvider(settings.appAiModelReasoning) === "openai" ? "GPT系はOpenAI APIを使わず、サブPCのCodex CLI（ChatGPTサブスク枠）で実行します。" : undefined,
    },
    {
      group: "アプリ内AI", name: "新規アプリ相談・手作業の修正提案", location: "IssueDeckサーバー",
      agent: appAiAgent(settings.appAiModelReasoning), model: appAiModelLabel(settings.appAiModelReasoning), source: "アプリ内AI（推論）設定", sourceId: "app-ai-settings",
      note: appAiProvider(settings.appAiModelReasoning) === "openai" ? "GPT系を選ぶとOpenAI APIの従量課金で実行されます（この機能はまだCodex CLIへ移っていません）。" : undefined,
    },
    {
      group: "判定", name: "おまかせのモデル選択・Issueラベル判定", location: settings.modelPickEngine === "jev" ? "TypeSafe" : "IssueDeckサーバー",
      agent: settings.modelPickEngine === "jev" ? "Jev" : appAiAgent(settings.appAiModel), model: settings.modelPickEngine === "jev" ? "Jev（候補から判定）" : appAiModelLabel(settings.appAiModel),
      source: "判定に使うAI設定", sourceId: "model-pick-settings", note: settings.modelPickEngine === "jev" ? "Jevが利用できない場合はアプリ内AIで判定します。" : undefined,
    },
  ];
}

/**
 * 機能別のAI設定のうち、プロバイダー（`aiExecutionProvider`）へ追従させず個別に固定しているもの（#4108）。
 *
 * 画面へ渡す値は`inherit`を解決済みなので、追従か固定かは値からは読めない。DBの生の値が
 * `inherit`以外（＝その値として読める）なら固定、と判定してここへ持つ。
 */
export type AiProviderOverrides = {
  githubActionsAgent: boolean;
  defaultDispatchAgent: boolean;
  planReviewAgentForClaude: boolean;
  planReviewAgentForCodex: boolean;
  appAiModel: boolean;
  appAiModelReasoning: boolean;
};

export const NO_AI_PROVIDER_OVERRIDES: AiProviderOverrides = {
  githubActionsAgent: false,
  defaultDispatchAgent: false,
  planReviewAgentForClaude: false,
  planReviewAgentForCodex: false,
  appAiModel: false,
  appAiModelReasoning: false,
};

/** DBの`AppSetting`行（生の値）から、個別に固定している項目を読む。 */
export function readAiProviderOverrides(row: {
  githubActionsAgent?: unknown;
  defaultDispatchAgent?: unknown;
  planReviewAgentForClaude?: unknown;
  planReviewAgentForCodex?: unknown;
  appAiModel?: unknown;
  appAiModelReasoning?: unknown;
} | null | undefined): AiProviderOverrides {
  return {
    githubActionsAgent: parseDefaultDispatchAgent(row?.githubActionsAgent) !== null,
    defaultDispatchAgent: parseDefaultDispatchAgent(row?.defaultDispatchAgent) !== null,
    planReviewAgentForClaude: parseDefaultDispatchAgent(row?.planReviewAgentForClaude) !== null,
    planReviewAgentForCodex: parseDefaultDispatchAgent(row?.planReviewAgentForCodex) !== null,
    appAiModel: parseAppAiModel(row?.appAiModel) !== null,
    appAiModelReasoning: parseAppAiModel(row?.appAiModelReasoning) !== null,
  };
}

/**
 * 工程ごとの値が何で決まるか。
 * - provider: プロバイダーの切替に追従する
 * - override: 個別に固定しており、切替の影響を受けない
 * - implementation: その工程の前に実装したエージェントで決まる（PRレビュー・修復）
 * - independent: プロバイダーと無関係な設定（判定に使うAI）
 */
export type ProviderFlowBinding = "provider" | "override" | "implementation" | "independent";

export type ProviderFlowEntry = {
  /** 実行先、またはアプリ内AIのように同じ実行先で用途が分かれるときは用途 */
  label: string;
  agent: string;
  model: string;
  reasoningEffort?: string;
  binding: ProviderFlowBinding;
  note?: string;
};

export type ProviderFlowStep = "計画" | "実装" | "計画レビュー" | "PRレビュー" | "レビュー修復" | "アプリ内AI" | "判定";

export type ProviderFlowRow = {
  step: ProviderFlowStep;
  entries: ProviderFlowEntry[];
  /** 「設定へ」で移動する設定欄のid */
  sourceId: string;
  /** PRレビュー・修復のworkflow専用モデルは、行から直接変更する */
  editsWorkflowModels: boolean;
};

export type ProviderFlowSettings = ExecutionFlowSettings & {
  defaultDispatchAgent: DefaultDispatchAgent;
};

function agentLabel(agent: PlanReviewAgent) {
  return agent === "claude" ? "Claude Code" : "Codex CLI";
}

/**
 * 「このプロバイダーを選ぶと各工程は何で動くか」を、工程の並びを固定して返す（#4108）。
 *
 * 個別に固定していない項目をプロバイダーで解決し直してから`resolveExecutionFlows`に渡し、
 * その結果から工程ごとの行を選ぶ。モデル名の解決は`resolveExecutionFlows`に任せ、ここでは
 * 「どの行を選ぶか」と「何で決まるか」だけを持つ。
 */
export function resolveProviderFlowRows(
  settings: ProviderFlowSettings,
  provider: DefaultDispatchAgent,
  overrides: AiProviderOverrides,
): ProviderFlowRow[] {
  const pick = <T>(fixed: boolean, value: T, inherited: T) => (fixed ? value : inherited);
  const subAgent = pick(overrides.defaultDispatchAgent, settings.defaultDispatchAgent, provider);
  const actionsAgentValue = pick(overrides.githubActionsAgent, settings.githubActionsAgent, provider);
  const planReviewAgentForClaude = pick(overrides.planReviewAgentForClaude, settings.planReviewAgentForClaude, provider);
  const planReviewAgentForCodex = pick(overrides.planReviewAgentForCodex, settings.planReviewAgentForCodex, provider);
  const appAiModel = pick(overrides.appAiModel, settings.appAiModel, resolveAppAiModel(undefined, provider));
  const appAiModelReasoning = pick(
    overrides.appAiModelReasoning,
    settings.appAiModelReasoning,
    resolveAppAiModel(undefined, provider, true),
  );
  const flows = resolveExecutionFlows({
    ...settings,
    githubActionsAgent: actionsAgentValue,
    planReviewAgentForClaude,
    planReviewAgentForCodex,
    appAiModel,
    appAiModelReasoning,
  });
  const find = (name: string, agent?: string) => {
    const flow = flows.find((candidate) => candidate.name === name && (!agent || candidate.agent === agent));
    if (!flow) throw new Error(`実行経路が見つかりません: ${name}`);
    return flow;
  };
  const entry = (flow: ExecutionFlow, binding: ProviderFlowBinding, label = flow.location): ProviderFlowEntry => ({
    label,
    agent: flow.agent,
    model: flow.model,
    ...(flow.reasoningEffort ? { reasoningEffort: flow.reasoningEffort } : {}),
    binding,
    ...(flow.note ? { note: flow.note } : {}),
  });
  const subBinding: ProviderFlowBinding = overrides.defaultDispatchAgent ? "override" : "provider";
  const actionsBinding: ProviderFlowBinding = overrides.githubActionsAgent ? "override" : "provider";
  const planReviewFixed = subAgent === "claude" ? overrides.planReviewAgentForClaude : overrides.planReviewAgentForCodex;
  // PRレビュー・修復は実装したCLIの側で走る。サブPCとActionsで実装エージェントが違えば両方を出す
  const implementationAgents = [...new Set([subAgent, actionsAgentValue])];
  const reviewFlows = (prefix: "PRコードレビュー" | "レビュー指摘修正") =>
    implementationAgents.map((agent) => {
      const flow = prefix === "PRコードレビュー"
        ? find(`PRコードレビュー（${agent === "claude" ? "Claude" : "Codex"}）`)
        : find(agent === "claude"
          ? "レビュー指摘修正（Claude）・CI自動修正・コンフリクト解消・PR repair"
          : "レビュー指摘修正（Codex）");
      return entry(flow, "implementation", `${flow.location}（${agent === "claude" ? "Claude" : "Codex"}実装）`);
    });
  const pickFlow = find("おまかせのモデル選択・Issueラベル判定");

  return [
    {
      step: "計画",
      entries: [
        entry(find("計画作成（サブPC）", agentLabel(subAgent)), subBinding),
        entry(find("計画作成（無人実行）"), actionsBinding),
      ],
      sourceId: "subpc-model-settings",
      editsWorkflowModels: false,
    },
    {
      step: "実装",
      entries: [
        entry(find(`通常実装・セッション継続（${subAgent === "claude" ? "Claude" : "Codex"}）`), subBinding),
        entry(find("通常実装・追加修正（無人実行）"), actionsBinding),
      ],
      sourceId: "subpc-model-settings",
      editsWorkflowModels: false,
    },
    {
      step: "計画レビュー",
      entries: [
        entry(
          find(`自動計画レビュー（${subAgent === "claude" ? "Claude Codeで開始後" : "Codex CLIで開始後"}）`),
          planReviewFixed ? "override" : "provider",
        ),
      ],
      sourceId: "plan-review-settings",
      editsWorkflowModels: false,
    },
    { step: "PRレビュー", entries: reviewFlows("PRコードレビュー"), sourceId: "github-actions-settings", editsWorkflowModels: true },
    { step: "レビュー修復", entries: reviewFlows("レビュー指摘修正"), sourceId: "github-actions-settings", editsWorkflowModels: true },
    {
      step: "アプリ内AI",
      entries: [
        entry(find("要約・検索・文章整理・手作業アシスタント"), overrides.appAiModel ? "override" : "provider", "要約・検索・文章整理"),
        entry(find("原因診断（チャット調査）"), overrides.appAiModelReasoning ? "override" : "provider", "原因診断（チャット）"),
        entry(find("新規アプリ相談・手作業の修正提案"), overrides.appAiModelReasoning ? "override" : "provider", "新規アプリ相談・修正提案"),
      ],
      sourceId: "app-ai-settings",
      editsWorkflowModels: false,
    },
    {
      step: "判定",
      entries: [
        entry(
          pickFlow,
          settings.modelPickEngine === "jev" ? "independent" : overrides.appAiModel ? "override" : "provider",
          "おまかせ・ラベル付与",
        ),
      ],
      sourceId: "model-pick-settings",
      editsWorkflowModels: false,
    },
  ];
}
