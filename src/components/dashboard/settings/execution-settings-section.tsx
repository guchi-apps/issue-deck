"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlanReviewAutoReflectField } from "@/components/dashboard/settings/plan-review-auto-reflect-field";
import { CodeReviewRecommendField } from "@/components/dashboard/settings/code-review-recommend-field";
import { ReleasePrepIntervalField } from "@/components/dashboard/settings/release-prep-interval-field";
import { ExecutionFlowOverview } from "@/components/dashboard/settings/execution-flow-overview";
import { InfoHint } from "@/components/dashboard/settings/info-hint";
import { useAppSettingsMutations } from "@/hooks/use-app-settings-mutations";
import {
  AUTO_RETRY_LIMIT_MAX,
  AUTO_RETRY_LIMIT_MIN,
  APP_AI_MODEL_OPTIONS,
  CLAUDE_LOCAL_MODEL_OPTIONS,
  CLAUDE_LOCAL_MODEL_SETTING_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_SETTING_OPTIONS,
  CODEX_LOCAL_MODEL_OPTIONS,
  DISPATCH_AGENT_OPTIONS,
  DISPATCH_CONCURRENCY_MAX,
  DISPATCH_CONCURRENCY_MIN,
  DISPATCH_FAILOVER_THRESHOLD_PERCENT_MAX,
  DISPATCH_FAILOVER_THRESHOLD_PERCENT_MIN,
  MODEL_PICK_ENGINE_OPTIONS,
  resolveAppAiModel,
  type AppAiModel,
  type AiExecutionProvider,
  type ClaudeLocalModel,
  type ClaudeLocalModelSetting,
  type ClaudeModel,
  type CodexModelSetting,
  type CodexLocalModel,
  type DefaultDispatchAgent,
  type GithubActionsAgent,
  type ModelPickEngine,
  type PlanReviewAgent,
} from "@/lib/app-settings";
import { NO_AI_PROVIDER_OVERRIDES, type AiProviderOverrides } from "@/lib/execution-flow-settings";

export type AppSettingsValues = {
  aiExecutionProvider: AiExecutionProvider;
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  githubActionsAgent: GithubActionsAgent;
  githubActionsCodexModel: CodexLocalModel;
  claudeModelAssist: ClaudeModel;
  claudeLocalModel: ClaudeLocalModelSetting;
  codexModel: CodexModelSetting;
  defaultDispatchAgent: DefaultDispatchAgent;
  planReviewAgentForClaude: PlanReviewAgent;
  planReviewAgentForCodex: PlanReviewAgent;
  planReviewClaudeModel: ClaudeLocalModel;
  planReviewCodexModel: CodexLocalModel;
  dispatchFailoverEnabled: boolean;
  dispatchFailoverThresholdPercent: number;
  appAiModel: AppAiModel;
  appAiModelReasoning: AppAiModel;
  modelPickEngine: ModelPickEngine;
  dispatchConcurrency: number;
  /** プロバイダーへ追従させず個別に固定している項目（#4108）。保存した項目はここで固定扱いになる */
  aiProviderOverrides: AiProviderOverrides;
};

export type ExecutionSettingsMode = "ai" | "execution" | "automation" | "all";

export type ExecutionSettingsSectionProps = {
  /** 既存の保存APIを保ったまま、設定の目的ごとにフォームを表示する。 */
  mode?: ExecutionSettingsMode;
  autoRetryLimit: number;
  aiExecutionProvider: AiExecutionProvider;
  claudeModel: ClaudeModel;
  githubActionsAgent: GithubActionsAgent;
  githubActionsCodexModel: CodexLocalModel;
  claudeModelAssist: ClaudeModel;
  claudeLocalModel: ClaudeLocalModelSetting;
  codexModel: CodexModelSetting;
  defaultDispatchAgent: DefaultDispatchAgent;
  planReviewAgentForClaude: PlanReviewAgent;
  planReviewAgentForCodex: PlanReviewAgent;
  planReviewClaudeModel: ClaudeLocalModel;
  planReviewCodexModel: CodexLocalModel;
  dispatchFailoverEnabled: boolean;
  dispatchFailoverThresholdPercent: number;
  appAiModel: AppAiModel;
  appAiModelReasoning: AppAiModel;
  modelPickEngine: ModelPickEngine;
  dispatchConcurrency: number;
  aiProviderOverrides?: AiProviderOverrides;
  // 設定項目が増えるたびに引数の順番を覚え直すことになるため、まとめて1つの値で渡す
  onUpdated: (values: AppSettingsValues) => void;
};

/**
 * 設定の「実行設定」区分（#1539）。**保存を押すまで効かない値だけ**を置く。
 *
 * 以前は同じダイアログに即時実行のセクション（共有ワークフローのバージョン・
 * シークレット同期）が同居し、フッターの「保存」がどこまで効くのか分からなかった。
 * 保存ボタンを持つのはこの区分だけ、という切り分けを保つこと。
 */
// 「設定へ」で移動できる欄。計画レビューの設定は「自動化」区分にあり、AIモデル区分には無い
const FLOW_SOURCE_IDS_AI = ["subpc-model-settings", "github-actions-settings", "app-ai-settings", "model-pick-settings"] as const;
const FLOW_SOURCE_IDS_ALL = [...FLOW_SOURCE_IDS_AI, "plan-review-settings"] as const;

export function ExecutionSettingsSection({
  mode = "all",
  autoRetryLimit: initialAutoRetryLimit,
  aiExecutionProvider: initialAiExecutionProvider,
  claudeModel: initialClaudeModel,
  githubActionsAgent: initialGithubActionsAgent,
  githubActionsCodexModel: initialGithubActionsCodexModel,
  claudeModelAssist: initialClaudeModelAssist,
  claudeLocalModel: initialClaudeLocalModel,
  codexModel: initialCodexModel,
  defaultDispatchAgent: initialDefaultDispatchAgent,
  planReviewAgentForClaude: initialPlanReviewAgentForClaude,
  planReviewAgentForCodex: initialPlanReviewAgentForCodex,
  planReviewClaudeModel: initialPlanReviewClaudeModel,
  planReviewCodexModel: initialPlanReviewCodexModel,
  dispatchFailoverEnabled: initialDispatchFailoverEnabled,
  dispatchFailoverThresholdPercent: initialDispatchFailoverThresholdPercent,
  appAiModel: initialAppAiModel,
  appAiModelReasoning: initialAppAiModelReasoning,
  modelPickEngine: initialModelPickEngine,
  dispatchConcurrency: initialDispatchConcurrency,
  aiProviderOverrides = NO_AI_PROVIDER_OVERRIDES,
  onUpdated,
}: ExecutionSettingsSectionProps) {
  const { updateAutoRetryLimit, updateClaudeModel, updateDispatchConcurrency, isSubmitting, error } =
    useAppSettingsMutations();
  const [autoRetryLimit, setAutoRetryLimit] = useState(initialAutoRetryLimit);
  const [aiExecutionProvider, setAiExecutionProvider] = useState<AiExecutionProvider>(initialAiExecutionProvider);
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>(initialClaudeModel);
  const [githubActionsAgent, setGithubActionsAgent] = useState<GithubActionsAgent>(initialGithubActionsAgent);
  const [githubActionsCodexModel, setGithubActionsCodexModel] = useState<CodexLocalModel>(initialGithubActionsCodexModel);
  const [claudeModelAssist, setClaudeModelAssist] =
    useState<ClaudeModel>(initialClaudeModelAssist);
  const [claudeLocalModel, setClaudeLocalModel] =
    useState<ClaudeLocalModelSetting>(initialClaudeLocalModel);
  const [codexModel, setCodexModel] = useState<CodexModelSetting>(initialCodexModel);
  const [defaultDispatchAgent, setDefaultDispatchAgent] = useState<DefaultDispatchAgent>(
    initialDefaultDispatchAgent,
  );
  const [planReviewAgentForClaude, setPlanReviewAgentForClaude] = useState<PlanReviewAgent>(
    initialPlanReviewAgentForClaude,
  );
  const [planReviewAgentForCodex, setPlanReviewAgentForCodex] = useState<PlanReviewAgent>(
    initialPlanReviewAgentForCodex,
  );
  const [planReviewClaudeModel, setPlanReviewClaudeModel] = useState<ClaudeLocalModel>(
    initialPlanReviewClaudeModel,
  );
  const [planReviewCodexModel, setPlanReviewCodexModel] = useState<CodexLocalModel>(
    initialPlanReviewCodexModel,
  );
  const [dispatchFailoverEnabled, setDispatchFailoverEnabled] = useState(initialDispatchFailoverEnabled);
  const [dispatchFailoverThresholdPercent, setDispatchFailoverThresholdPercent] = useState(
    initialDispatchFailoverThresholdPercent,
  );
  const [appAiModel, setAppAiModel] = useState<AppAiModel>(initialAppAiModel);
  const [appAiModelReasoning, setAppAiModelReasoning] =
    useState<AppAiModel>(initialAppAiModelReasoning);
  const [modelPickEngine, setModelPickEngine] =
    useState<ModelPickEngine>(initialModelPickEngine);
  const [dispatchConcurrency, setDispatchConcurrency] = useState(initialDispatchConcurrency);
  const [isSaved, setIsSaved] = useState(false);
  const previousInitials = useRef({
    autoRetryLimit: initialAutoRetryLimit,
    aiExecutionProvider: initialAiExecutionProvider,
    claudeModel: initialClaudeModel,
    githubActionsAgent: initialGithubActionsAgent,
    githubActionsCodexModel: initialGithubActionsCodexModel,
    claudeModelAssist: initialClaudeModelAssist,
    claudeLocalModel: initialClaudeLocalModel,
    codexModel: initialCodexModel,
    defaultDispatchAgent: initialDefaultDispatchAgent,
    planReviewAgentForClaude: initialPlanReviewAgentForClaude,
    planReviewAgentForCodex: initialPlanReviewAgentForCodex,
    planReviewClaudeModel: initialPlanReviewClaudeModel,
    planReviewCodexModel: initialPlanReviewCodexModel,
    dispatchFailoverEnabled: initialDispatchFailoverEnabled,
    dispatchFailoverThresholdPercent: initialDispatchFailoverThresholdPercent,
    appAiModel: initialAppAiModel,
    appAiModelReasoning: initialAppAiModelReasoning,
    modelPickEngine: initialModelPickEngine,
    dispatchConcurrency: initialDispatchConcurrency,
  });

  // PCでは3区分をhiddenで常駐させて未保存入力を保持する。そのため兄弟区分が保存されて
  // 親propsが更新されたときは「そのフォームで未編集の項目」だけ最新保存値へ追従させる。
  // ローカル値が以前のinitialと違う項目は編集中なので上書きしない。
  useEffect(() => {
    const prev = previousInitials.current;
    setAutoRetryLimit((value) => value === prev.autoRetryLimit ? initialAutoRetryLimit : value);
    setAiExecutionProvider((value) => value === prev.aiExecutionProvider ? initialAiExecutionProvider : value);
    setClaudeModel((value) => value === prev.claudeModel ? initialClaudeModel : value);
    setGithubActionsAgent((value) => value === prev.githubActionsAgent ? initialGithubActionsAgent : value);
    setGithubActionsCodexModel((value) => value === prev.githubActionsCodexModel ? initialGithubActionsCodexModel : value);
    setClaudeModelAssist((value) => value === prev.claudeModelAssist ? initialClaudeModelAssist : value);
    setClaudeLocalModel((value) => value === prev.claudeLocalModel ? initialClaudeLocalModel : value);
    setCodexModel((value) => value === prev.codexModel ? initialCodexModel : value);
    setDefaultDispatchAgent((value) => value === prev.defaultDispatchAgent ? initialDefaultDispatchAgent : value);
    setPlanReviewAgentForClaude((value) => value === prev.planReviewAgentForClaude ? initialPlanReviewAgentForClaude : value);
    setPlanReviewAgentForCodex((value) => value === prev.planReviewAgentForCodex ? initialPlanReviewAgentForCodex : value);
    setPlanReviewClaudeModel((value) => value === prev.planReviewClaudeModel ? initialPlanReviewClaudeModel : value);
    setPlanReviewCodexModel((value) => value === prev.planReviewCodexModel ? initialPlanReviewCodexModel : value);
    setDispatchFailoverEnabled((value) => value === prev.dispatchFailoverEnabled ? initialDispatchFailoverEnabled : value);
    setDispatchFailoverThresholdPercent((value) => value === prev.dispatchFailoverThresholdPercent ? initialDispatchFailoverThresholdPercent : value);
    setAppAiModel((value) => value === prev.appAiModel ? initialAppAiModel : value);
    setAppAiModelReasoning((value) => value === prev.appAiModelReasoning ? initialAppAiModelReasoning : value);
    setModelPickEngine((value) => value === prev.modelPickEngine ? initialModelPickEngine : value);
    setDispatchConcurrency((value) => value === prev.dispatchConcurrency ? initialDispatchConcurrency : value);
    previousInitials.current = {
      autoRetryLimit: initialAutoRetryLimit, aiExecutionProvider: initialAiExecutionProvider, claudeModel: initialClaudeModel,
      githubActionsAgent: initialGithubActionsAgent, githubActionsCodexModel: initialGithubActionsCodexModel,
      claudeModelAssist: initialClaudeModelAssist, claudeLocalModel: initialClaudeLocalModel,
      codexModel: initialCodexModel, defaultDispatchAgent: initialDefaultDispatchAgent,
      planReviewAgentForClaude: initialPlanReviewAgentForClaude, planReviewAgentForCodex: initialPlanReviewAgentForCodex,
      planReviewClaudeModel: initialPlanReviewClaudeModel, planReviewCodexModel: initialPlanReviewCodexModel,
      dispatchFailoverEnabled: initialDispatchFailoverEnabled,
      dispatchFailoverThresholdPercent: initialDispatchFailoverThresholdPercent,
      appAiModel: initialAppAiModel, appAiModelReasoning: initialAppAiModelReasoning,
      modelPickEngine: initialModelPickEngine, dispatchConcurrency: initialDispatchConcurrency,
    };
  }, [
    initialAiExecutionProvider,
    initialAutoRetryLimit, initialClaudeModel, initialGithubActionsAgent, initialGithubActionsCodexModel,
    initialClaudeModelAssist, initialClaudeLocalModel, initialCodexModel, initialDefaultDispatchAgent,
    initialPlanReviewAgentForClaude, initialPlanReviewAgentForCodex, initialPlanReviewClaudeModel,
    initialPlanReviewCodexModel, initialDispatchFailoverEnabled, initialDispatchFailoverThresholdPercent,
    initialAppAiModel, initialAppAiModelReasoning, initialModelPickEngine, initialDispatchConcurrency,
  ]);

  const executionValid =
    Number.isInteger(autoRetryLimit) &&
    autoRetryLimit >= AUTO_RETRY_LIMIT_MIN &&
    autoRetryLimit <= AUTO_RETRY_LIMIT_MAX &&
    Number.isInteger(dispatchConcurrency) &&
    dispatchConcurrency >= DISPATCH_CONCURRENCY_MIN &&
    dispatchConcurrency <= DISPATCH_CONCURRENCY_MAX &&
    Number.isInteger(dispatchFailoverThresholdPercent) &&
    dispatchFailoverThresholdPercent >= DISPATCH_FAILOVER_THRESHOLD_PERCENT_MIN &&
    dispatchFailoverThresholdPercent <= DISPATCH_FAILOVER_THRESHOLD_PERCENT_MAX;
  // 区分は独立保存なので、非表示の兄弟フォームに不正な編集中値があっても現在区分を阻害しない。
  const isValid = mode === "execution" || mode === "all" ? executionValid : true;

  const isDirty =
    autoRetryLimit !== initialAutoRetryLimit ||
    aiExecutionProvider !== initialAiExecutionProvider ||
    aiExecutionProvider !== initialAiExecutionProvider ||
    claudeModel !== initialClaudeModel ||
    githubActionsAgent !== initialGithubActionsAgent ||
    githubActionsCodexModel !== initialGithubActionsCodexModel ||
    claudeModelAssist !== initialClaudeModelAssist ||
    claudeLocalModel !== initialClaudeLocalModel ||
    codexModel !== initialCodexModel ||
    defaultDispatchAgent !== initialDefaultDispatchAgent ||
    planReviewAgentForClaude !== initialPlanReviewAgentForClaude ||
    planReviewAgentForCodex !== initialPlanReviewAgentForCodex ||
    planReviewClaudeModel !== initialPlanReviewClaudeModel ||
    planReviewCodexModel !== initialPlanReviewCodexModel ||
    dispatchFailoverEnabled !== initialDispatchFailoverEnabled ||
    dispatchFailoverThresholdPercent !== initialDispatchFailoverThresholdPercent ||
    appAiModel !== initialAppAiModel ||
    appAiModelReasoning !== initialAppAiModelReasoning ||
    modelPickEngine !== initialModelPickEngine ||
    dispatchConcurrency !== initialDispatchConcurrency;

  const aiDirty =
    aiExecutionProvider !== initialAiExecutionProvider ||
    claudeModel !== initialClaudeModel ||
    githubActionsAgent !== initialGithubActionsAgent ||
    githubActionsCodexModel !== initialGithubActionsCodexModel ||
    claudeModelAssist !== initialClaudeModelAssist ||
    claudeLocalModel !== initialClaudeLocalModel ||
    codexModel !== initialCodexModel ||
    appAiModel !== initialAppAiModel ||
    appAiModelReasoning !== initialAppAiModelReasoning ||
    modelPickEngine !== initialModelPickEngine;
  const executionDirty =
    autoRetryLimit !== initialAutoRetryLimit ||
    defaultDispatchAgent !== initialDefaultDispatchAgent ||
    dispatchFailoverEnabled !== initialDispatchFailoverEnabled ||
    dispatchFailoverThresholdPercent !== initialDispatchFailoverThresholdPercent ||
    dispatchConcurrency !== initialDispatchConcurrency;
  const automationDirty =
    planReviewAgentForClaude !== initialPlanReviewAgentForClaude ||
    planReviewAgentForCodex !== initialPlanReviewAgentForCodex ||
    planReviewClaudeModel !== initialPlanReviewClaudeModel ||
    planReviewCodexModel !== initialPlanReviewCodexModel;
  const sectionDirty =
    mode === "ai" ? aiDirty :
    mode === "execution" ? executionDirty :
    mode === "automation" ? automationDirty :
    isDirty;


  // 画面で選び直した機能別の値は、保存すると個別設定になる。表の「追従」が保存後の実態とずれないよう、
  // 未保存でも初期値から変えた項目は個別設定として見せる
  const displayOverrides: AiProviderOverrides = {
    githubActionsAgent: aiProviderOverrides.githubActionsAgent || githubActionsAgent !== initialGithubActionsAgent,
    defaultDispatchAgent: aiProviderOverrides.defaultDispatchAgent || defaultDispatchAgent !== initialDefaultDispatchAgent,
    planReviewAgentForClaude: aiProviderOverrides.planReviewAgentForClaude || planReviewAgentForClaude !== initialPlanReviewAgentForClaude,
    planReviewAgentForCodex: aiProviderOverrides.planReviewAgentForCodex || planReviewAgentForCodex !== initialPlanReviewAgentForCodex,
    appAiModel: aiProviderOverrides.appAiModel || appAiModel !== initialAppAiModel,
    appAiModelReasoning: aiProviderOverrides.appAiModelReasoning || appAiModelReasoning !== initialAppAiModelReasoning,
  };

  async function handleSubmit() {
    setIsSaved(false);
    if (mode === "execution" || mode === "all") {
      const autoRetryOk = await updateAutoRetryLimit(autoRetryLimit);
      if (!autoRetryOk) return;
    }
    const onlyAiExecutionProviderChanged =
      mode === "ai" &&
      aiExecutionProvider !== initialAiExecutionProvider &&
      claudeModel === initialClaudeModel &&
      githubActionsAgent === initialGithubActionsAgent &&
      githubActionsCodexModel === initialGithubActionsCodexModel &&
      claudeModelAssist === initialClaudeModelAssist &&
      claudeLocalModel === initialClaudeLocalModel &&
      codexModel === initialCodexModel &&
      appAiModel === initialAppAiModel &&
      appAiModelReasoning === initialAppAiModelReasoning &&
      modelPickEngine === initialModelPickEngine;
    const modelValues =
      onlyAiExecutionProviderChanged
        ? { aiExecutionProvider }
        :
      mode === "ai"
        ? {
            claudeModel,
            aiExecutionProvider,
            githubActionsAgent,
            githubActionsCodexModel,
            claudeModelAssist,
            claudeLocalModel,
            codexModel,
            appAiModel,
            appAiModelReasoning,
            modelPickEngine,
          }
        : mode === "execution"
          ? {
              defaultDispatchAgent,
              dispatchFailoverEnabled,
              dispatchFailoverThresholdPercent,
            }
          : mode === "automation"
            ? {
                planReviewAgentForClaude,
                planReviewAgentForCodex,
                planReviewClaudeModel,
                planReviewCodexModel,
              }
            : {
                claudeModel,
                aiExecutionProvider,
                githubActionsAgent,
                githubActionsCodexModel,
                claudeModelAssist,
                claudeLocalModel,
                codexModel,
                appAiModel,
                appAiModelReasoning,
                modelPickEngine,
                defaultDispatchAgent,
                planReviewAgentForClaude,
                planReviewAgentForCodex,
                planReviewClaudeModel,
                planReviewCodexModel,
                dispatchFailoverEnabled,
                dispatchFailoverThresholdPercent,
              };
    const claudeModelOk = await updateClaudeModel(modelValues);
    if (!claudeModelOk) return;
    if (mode === "execution" || mode === "all") {
      const dispatchOk = await updateDispatchConcurrency(dispatchConcurrency);
      if (!dispatchOk) return;
    }
    // 送った機能別の値はAPIがそのまま保存し、以後はプロバイダーへ追従しない（`inherit`ではなくなる）。
    // 保存後のバッジがずれないよう、送った項目を個別設定として親へ返す（#4108）
    const sent = modelValues as Partial<Record<keyof AiProviderOverrides, unknown>>;
    const nextOverrides = Object.fromEntries(
      (Object.keys(aiProviderOverrides) as (keyof AiProviderOverrides)[]).map((key) => [
        key,
        aiProviderOverrides[key] || key in sent,
      ]),
    ) as AiProviderOverrides;
    // 親へも「この区分で実際に保存した値」だけを反映する。他区分の未保存stateを
    // 保存済みpropsへ混ぜると、未保存表示が消えたり後の保存で巻き戻るため、initial値を維持する。
    const saved: AppSettingsValues = {
      autoRetryLimit: mode === "execution" || mode === "all" ? autoRetryLimit : initialAutoRetryLimit,
      aiExecutionProvider: mode === "ai" || mode === "all" ? aiExecutionProvider : initialAiExecutionProvider,
      claudeModel: mode === "ai" || mode === "all" ? claudeModel : initialClaudeModel,
      githubActionsAgent: mode === "ai" || mode === "all" ? githubActionsAgent : initialGithubActionsAgent,
      githubActionsCodexModel: mode === "ai" || mode === "all" ? githubActionsCodexModel : initialGithubActionsCodexModel,
      claudeModelAssist: mode === "ai" || mode === "all" ? claudeModelAssist : initialClaudeModelAssist,
      claudeLocalModel: mode === "ai" || mode === "all" ? claudeLocalModel : initialClaudeLocalModel,
      codexModel: mode === "ai" || mode === "all" ? codexModel : initialCodexModel,
      defaultDispatchAgent: mode === "execution" || mode === "all" ? defaultDispatchAgent : initialDefaultDispatchAgent,
      planReviewAgentForClaude: mode === "automation" || mode === "all" ? planReviewAgentForClaude : initialPlanReviewAgentForClaude,
      planReviewAgentForCodex: mode === "automation" || mode === "all" ? planReviewAgentForCodex : initialPlanReviewAgentForCodex,
      planReviewClaudeModel: mode === "automation" || mode === "all" ? planReviewClaudeModel : initialPlanReviewClaudeModel,
      planReviewCodexModel: mode === "automation" || mode === "all" ? planReviewCodexModel : initialPlanReviewCodexModel,
      dispatchFailoverEnabled: mode === "execution" || mode === "all" ? dispatchFailoverEnabled : initialDispatchFailoverEnabled,
      dispatchFailoverThresholdPercent: mode === "execution" || mode === "all" ? dispatchFailoverThresholdPercent : initialDispatchFailoverThresholdPercent,
      appAiModel: mode === "ai" || mode === "all" ? appAiModel : initialAppAiModel,
      appAiModelReasoning: mode === "ai" || mode === "all" ? appAiModelReasoning : initialAppAiModelReasoning,
      modelPickEngine: mode === "ai" || mode === "all" ? modelPickEngine : initialModelPickEngine,
      dispatchConcurrency: mode === "execution" || mode === "all" ? dispatchConcurrency : initialDispatchConcurrency,
      aiProviderOverrides: nextOverrides,
    };
    // 追従している項目は、保存したプロバイダーで解き直した値を返す（手元の値は保存前のプロバイダーで
    // 解決したものなので、プロバイダーだけを切り替えた保存では古いまま残ってしまう）
    const provider = saved.aiExecutionProvider;
    if (provider === initialAiExecutionProvider) {
      onUpdated(saved);
      setIsSaved(true);
      return;
    }
    onUpdated({
      ...saved,
      githubActionsAgent: nextOverrides.githubActionsAgent ? saved.githubActionsAgent : provider,
      defaultDispatchAgent: nextOverrides.defaultDispatchAgent ? saved.defaultDispatchAgent : provider,
      planReviewAgentForClaude: nextOverrides.planReviewAgentForClaude ? saved.planReviewAgentForClaude : provider,
      planReviewAgentForCodex: nextOverrides.planReviewAgentForCodex ? saved.planReviewAgentForCodex : provider,
      appAiModel: nextOverrides.appAiModel ? saved.appAiModel : resolveAppAiModel(undefined, provider),
      appAiModelReasoning: nextOverrides.appAiModelReasoning
        ? saved.appAiModelReasoning
        : resolveAppAiModel(undefined, provider, true),
    });
    setIsSaved(true);
  }

  return (
    <div className="flex flex-col gap-4">
      {(mode === "ai" || mode === "all") && <ExecutionFlowOverview
        aiExecutionProvider={aiExecutionProvider}
        savedAiExecutionProvider={initialAiExecutionProvider}
        onAiExecutionProviderChange={setAiExecutionProvider}
        overrides={displayOverrides}
        linkableSourceIds={mode === "all" ? FLOW_SOURCE_IDS_ALL : FLOW_SOURCE_IDS_AI}
        claudeModel={claudeModel}
        githubActionsAgent={githubActionsAgent}
        githubActionsCodexModel={githubActionsCodexModel}
        claudeModelAssist={claudeModelAssist}
        claudeLocalModel={claudeLocalModel}
        codexModel={codexModel}
        defaultDispatchAgent={defaultDispatchAgent}
        planReviewAgentForClaude={planReviewAgentForClaude}
        planReviewAgentForCodex={planReviewAgentForCodex}
        planReviewClaudeModel={planReviewClaudeModel}
        planReviewCodexModel={planReviewCodexModel}
        appAiModel={appAiModel}
        appAiModelReasoning={appAiModelReasoning}
        modelPickEngine={modelPickEngine}
      />}

      {(mode === "execution" || mode === "all") && <h3 className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">サブPCとエラー処理</h3>}

      {(mode === "execution" || mode === "all") && <div id="execution-controls" className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="auto-retry-limit">自動リトライ回数</Label>
          <InfoHint label="自動リトライ回数">
            GitHub
            Actionsの無人実行（Issueからの計画・実装）が、計画コメントもPull
            Requestも残せずに終わった場合に、自動で再実行する回数の上限です。0で無効ですが、一過性の障害と判定した場合だけは0でも2回まで再実行します。ローカルセッションには適用されません。全リポジトリ共通の設定です。
          </InfoHint>
        </div>
        <Input
          id="auto-retry-limit"
          type="number"
          min={AUTO_RETRY_LIMIT_MIN}
          max={AUTO_RETRY_LIMIT_MAX}
          value={autoRetryLimit}
          onChange={(e) => setAutoRetryLimit(Number(e.target.value))}
        />
        {/*
          この設定を読むのは`reusable-issue-dispatch.yml`のフォールバック検証ステップだけで、
          ローカルセッション（`scripts/start-issue.sh`）は参照しない。適用先を書かないと
          ローカル実行にも効くと読めてしまうため、対象と例外を明記する（#1808）。
        */}
      </div>}

      {(mode === "execution" || mode === "all") && <div id="subpc-agent-settings" className="flex flex-col gap-1.5 border-t pt-4">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="default-dispatch-agent">サブPC：既定のエージェント</Label>
          <InfoHint label="サブPC：既定のエージェント">
            「実装を開始」を開いたときの最初の選択です。Issueごとに選び直した値、既存セッションの再開、GitHub Actionsには影響しません。
          </InfoHint>
        </div>
        <Select
          value={defaultDispatchAgent}
          onValueChange={(value) => setDefaultDispatchAgent(value as DefaultDispatchAgent)}
        >
          <SelectTrigger id="default-dispatch-agent" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DISPATCH_AGENT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>}

      {(mode === "automation" || mode === "all") && <div id="plan-review-settings" className="flex flex-col gap-3 border-t pt-4">
        <div>
          <div className="flex items-center gap-1.5">
            <Label>サブPC：自動計画レビューのエージェントとモデル</Label>
            <InfoHint label="自動計画レビューのエージェントとモデル">
              計画を出したCLIごとに、続く自動計画レビューで使うエージェントを選びます。Issue詳細から手動で始める単独レビューの選択には影響しません。
            </InfoHint>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-review-agent-for-claude">Claude Codeで開始したとき</Label>
          <Select
            value={planReviewAgentForClaude}
            onValueChange={(value) => setPlanReviewAgentForClaude(value as PlanReviewAgent)}
          >
            <SelectTrigger id="plan-review-agent-for-claude" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DISPATCH_AGENT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-review-agent-for-codex">ChatGPT（Codex CLI）で開始したとき</Label>
          <Select
            value={planReviewAgentForCodex}
            onValueChange={(value) => setPlanReviewAgentForCodex(value as PlanReviewAgent)}
          >
            <SelectTrigger id="plan-review-agent-for-codex" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DISPATCH_AGENT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-review-claude-model">Claude Codeでレビューするときのモデル</Label>
          <Select
            value={planReviewClaudeModel}
            onValueChange={(value) => setPlanReviewClaudeModel(value as ClaudeLocalModel)}
          >
            <SelectTrigger id="plan-review-claude-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLAUDE_LOCAL_MODEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-review-codex-model">ChatGPT（Codex CLI）でレビューするときのモデル</Label>
          <Select
            value={planReviewCodexModel}
            onValueChange={(value) => setPlanReviewCodexModel(value as CodexLocalModel)}
          >
            <SelectTrigger id="plan-review-codex-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODEX_LOCAL_MODEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>}

      {(mode === "execution" || mode === "all") && <div id="failover-settings" className="flex flex-col gap-3 border-t pt-4">
        <div>
          <div className="flex items-center gap-1.5">
            <Label htmlFor="dispatch-failover-enabled">使用量に応じた自動フェイルオーバー</Label>
            <InfoHint label="使用量に応じた自動フェイルオーバー">
              既定のエージェントの使用率がしきい値以上なら、もう一方を「実装を開始」の最初の選択にします。
            </InfoHint>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm" htmlFor="dispatch-failover-enabled">
          <input
            id="dispatch-failover-enabled"
            type="checkbox"
            checked={dispatchFailoverEnabled}
            onChange={(event) => setDispatchFailoverEnabled(event.target.checked)}
          />
          自動で切り替える
        </label>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="dispatch-failover-threshold">切替しきい値（使用率）</Label>
            <InfoHint label="切替しきい値（使用率）">
              使用量を取得できない・古い・期限切れの場合は切り替えません。手動で選び直したエージェントも維持します。
            </InfoHint>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="dispatch-failover-threshold"
              type="number"
              min={DISPATCH_FAILOVER_THRESHOLD_PERCENT_MIN}
              max={DISPATCH_FAILOVER_THRESHOLD_PERCENT_MAX}
              value={dispatchFailoverThresholdPercent}
              disabled={!dispatchFailoverEnabled}
              onChange={(event) => setDispatchFailoverThresholdPercent(Number(event.target.value))}
              className="w-28"
            />
            <span className="text-sm text-muted-foreground">%以上</span>
          </div>
        </div>
      </div>}

      {(mode === "execution" || mode === "all") && <div id="concurrency-settings" className="flex flex-col gap-1.5 border-t pt-4">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="dispatch-concurrency">サブPCの同時実行数</Label>
          <InfoHint label="サブPCの同時実行数">
            サブPCへディスパッチしたジョブを同時に何本まで走らせるかの上限です。CPUの実力に
            合わせて変えられるよう設定値にしています（既定の3は載せ替え後のCPU実測にもとづく上限で、
            4本にするとメモリが足りずビルドが2倍以上遅くなります）。
          </InfoHint>
        </div>
        <Input
          id="dispatch-concurrency"
          type="number"
          min={DISPATCH_CONCURRENCY_MIN}
          max={DISPATCH_CONCURRENCY_MAX}
          value={dispatchConcurrency}
          onChange={(e) => setDispatchConcurrency(Number(e.target.value))}
        />
      </div>}

      {(mode === "ai" || mode === "all") && <>
      <h3 id="github-actions-settings" className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">GitHub Actions 共通設定</h3>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="github-actions-agent">エージェント</Label>
          <InfoHint label="エージェント">
            GitHub Actionsの計画・実装・レビューに使うCLIです。サブPCとは別に保存されます。
          </InfoHint>
        </div>
        <Select value={githubActionsAgent} onValueChange={(value) => setGithubActionsAgent(value as GithubActionsAgent)}>
          <SelectTrigger id="github-actions-agent" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{DISPATCH_AGENT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {githubActionsAgent === "codex" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="github-actions-codex-model">GitHub Actions（Codex）：使用モデル</Label>
          <Select value={githubActionsCodexModel} onValueChange={(value) => setGithubActionsCodexModel(value as CodexLocalModel)}>
            <SelectTrigger id="github-actions-codex-model" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{CODEX_LOCAL_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="claude-model">GitHub Actions（Claude）：計画・実装・レビュー</Label>
          <InfoHint label="GitHub Actions（Claude）：計画・実装・レビュー">
            Claude Codeを選んだときに、GitHub Actionsで計画を作り、計画をレビューし、実装してPRを作る処理に使います。
            通常はSonnet、難しい設計を優先する場合はOpusが適しています。全リポジトリ共通です。
          </InfoHint>
        </div>
        <Select value={claudeModel} onValueChange={(value) => setClaudeModel(value as ClaudeModel)}>
          <SelectTrigger id="claude-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLAUDE_MODEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="claude-model-assist">GitHub Actions（Claude）：質問回答・Issue分割</Label>
          <InfoHint label="GitHub Actions（Claude）：質問回答・Issue分割">
            GitHub Actionsで質問へ回答し、大きなIssueを分割する処理に使います。通常はHaikuで十分です。
          </InfoHint>
        </div>
        <Select
          value={claudeModelAssist}
          onValueChange={(value) => setClaudeModelAssist(value as ClaudeModel)}
        >
          <SelectTrigger id="claude-model-assist" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLAUDE_MODEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <h3 id="subpc-model-settings" className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">サブPC 共通設定</h3>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="claude-local-model">サブPC（Claude）：計画・実装</Label>
          <InfoHint label="サブPC（Claude）：計画・実装">
            「実装を開始」で最初から選ばれるモデルです。「おまかせ」を選ぶと、開くたびにIssueの内容から
            モデルを選びます。ただし「おまかせ」が効くのは「実装を開始」だけで、
            「ローカルで開始」・PR修正依頼の呼び戻し・一括停止からの再開など、モデルを選ばずに
            起動する経路ではSonnetで起動します。全リポジトリ共通です。Haikuはauto
            modeが動作しないため選べません（
            <a
              href="https://github.com/anthropics/claude-code/issues/43235"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              anthropics/claude-code#43235
            </a>
            ）。「Claude Codeに任せる」（`--model`を付けない起動）も、実際に動くモデルが分からなく
            なるため選べません（#2776）。
          </InfoHint>
        </div>
        <Select
          value={claudeLocalModel}
          onValueChange={(value) => setClaudeLocalModel(value as ClaudeLocalModelSetting)}
        >
          <SelectTrigger id="claude-local-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLAUDE_LOCAL_MODEL_SETTING_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="codex-model">Codex：サブPCでの計画・実装</Label>
          <InfoHint label="Codex：サブPCでの計画・実装">
            「実装を開始」でCodex CLIを選んだとき、最初から選ばれるモデルです。通常はTerra、難しい
            IssueはSol、単純な修正を優先する場合はLunaが適しています。「おまかせ」を選ぶと、開くたびに
            Issueの内容からSol・Terra・Lunaを選びます。ただし「おまかせ」が効くのは「実装を開始」だけで、
            モデルを選ばずに起動する経路（ローカルで開始など）ではTerraで起動します。
            旧世代（GPT-5.5・5.4）と「Codexに任せる」は、この設定でだけ選べます（ダイアログの初期選択は
            Terraになります）。全リポジトリ共通です。
          </InfoHint>
        </div>
        <Select value={codexModel} onValueChange={(value) => setCodexModel(value as CodexModelSetting)}>
          <SelectTrigger id="codex-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODEX_MODEL_SETTING_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 判定に使うAI（#3189・#3245）。**選ばれる側のモデルではなく、選ぶ側。**
          「おまかせ」のモデル選択と、Issue作成の「タイトル自動」で付くラベルの判定の両方に効く。
          サブPCのモデル設定（すぐ上）の直後に置く */}
      <div id="model-pick-settings" className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="model-pick-engine">判定に使うAI（おまかせ・ラベル付与）</Label>
          <InfoHint label="判定に使うAI（おまかせ・ラベル付与）">
            「実装を開始」で「おまかせ」を選んだときにモデルを選ぶ判定と、Issue作成で「タイトル自動」を
            使ったときにラベルを付ける判定に使うAIです（タイトルはどちらでもアプリ内AIが付けます）。
            Jevは文章を書かない判定専用のモデルで、渡した候補以外を返しません。
            選ぶとIssueのタイトル・本文・ラベル・承認済みの計画（ラベル付与では作成中の本文）が
            TypeSafeへ送られます（privateリポジトリのIssueも対象です）。TYPESAFE_API_KEYが未設定の
            とき・呼び出しに失敗したときは、アプリ内AIで判定します。
          </InfoHint>
        </div>
        <Select
          value={modelPickEngine}
          onValueChange={(value) => setModelPickEngine(value as ModelPickEngine)}
        >
          <SelectTrigger id="model-pick-engine" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODEL_PICK_ENGINE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* **送信先が1社増えることを、切り替えるこの場で伝える**（#3189の計画レビュー）。
            判定の材料はIssueのタイトル・本文・ラベル・承認済みの計画で、privateリポジトリの
            本文も含む。既定（アプリ内AI）のままなら送信先は今までどおり変わらない */}
        {modelPickEngine === "jev" && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            選択中：Issueのタイトル・本文・ラベル・承認済みの計画がTypeSafeへ送られます（privateリポジトリのIssueも対象です）。
          </p>
        )}
      </div>

      <div id="app-ai-settings" className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="app-ai-model">アプリ内AI：要約・検索・文章整理</Label>
          <InfoHint label="アプリ内AI：要約・検索・文章整理">
            Issueとコメントの要約、類似Issue検索、本文整理、並び替え、Issue作成補助に使います。
            定型処理が中心のため、通常はHaikuが適しています。
          </InfoHint>
        </div>
        <Select value={appAiModel} onValueChange={(value) => setAppAiModel(value as AppAiModel)}>
          <SelectTrigger id="app-ai-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_AI_MODEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="app-ai-model-reasoning">アプリ内AI：原因診断・新規アプリ相談</Label>
          <InfoHint label="アプリ内AI：原因診断・新規アプリ相談">
            手作業が失敗した原因の診断と、新規アプリの構成相談に使います。判断力が必要なため、
            通常はSonnetが適しています。GPTを選ぶとOpenAI API、Claudeを選ぶとAnthropic APIを使います。
          </InfoHint>
        </div>
        <Select
          value={appAiModelReasoning}
          onValueChange={(value) => setAppAiModelReasoning(value as AppAiModel)}
        >
          <SelectTrigger id="app-ai-model-reasoning" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_AI_MODEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      </>}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-3 border-t pt-4">
        <Button onClick={handleSubmit} disabled={isSubmitting || !isValid || !sectionDirty}>
          {isSubmitting ? "保存中..." : "保存"}
        </Button>
        {isSaved && !sectionDirty && (
          <span className="text-xs text-muted-foreground">保存しました</span>
        )}
        {sectionDirty && !isSubmitting && (
          <span className="text-xs text-muted-foreground">未保存の変更があります</span>
        )}
      </div>

      {(mode === "automation" || mode === "all") && <>
      {mode === "all" && <><h3 className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">自動化</h3><p className="-mt-2 text-xs text-muted-foreground">各項目の変更はその場で保存されます。</p></>}

      <ReleasePrepIntervalField />

      <CodeReviewRecommendField />

      <PlanReviewAutoReflectField />
      </>}
    </div>
  );
}
