"use client";

import { useEffect, useRef, useState } from "react";
import { GitBranch, Laptop, Sparkles } from "lucide-react";

import { ReleaseAutoApprovalField } from "@/components/dashboard/settings/release-auto-approval-field";
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
import { PlanReviewSettingsBlock, type WorkflowModelValues } from "@/components/dashboard/settings/plan-review-settings-block";
import {
  AiSectionNav,
  ProviderCard,
  ProviderColumns,
  ScopeChip,
  SettingField,
  SettingsCard,
  StickySaveBar,
} from "@/components/dashboard/settings/ai-model-layout";
import { PlanReviewAutoReflectField } from "@/components/dashboard/settings/plan-review-auto-reflect-field";
import { CodeReviewRecommendField } from "@/components/dashboard/settings/code-review-recommend-field";
import { ExecutionFlowOverview } from "@/components/dashboard/settings/execution-flow-overview";
import { InfoHint } from "@/components/dashboard/settings/info-hint";
import { useAppSettingsMutations } from "@/hooks/use-app-settings-mutations";
import {
  AI_PROVIDER_INHERIT,
  AUTO_RETRY_LIMIT_MAX,
  AUTO_RETRY_LIMIT_MIN,
  APP_AI_MODEL_OPTIONS,
  appAiProvider,
  CLAUDE_LOCAL_MODEL_SETTING_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_SETTING_OPTIONS,
  CODEX_LOCAL_MODEL_OPTIONS,
  CODEX_REASONING_EFFORT_DEFAULT,
  DISPATCH_AGENT_OPTIONS,
  DISPATCH_CONCURRENCY_MAX,
  DISPATCH_CONCURRENCY_MIN,
  DISPATCH_FAILOVER_THRESHOLD_PERCENT_MAX,
  DISPATCH_FAILOVER_THRESHOLD_PERCENT_MIN,
  MODEL_PICK_ENGINE_OPTIONS,
  resolveAppAiModel,
  resolvePlanReviewAgent,
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
  type PlanReviewAgentSetting,
} from "@/lib/app-settings";
import { describeReleaseReviewAssignee, resolveReleaseReviewAssignee } from "@/lib/release-review-assignee";
import { countProcessOverrides, NO_AI_PROVIDER_OVERRIDES, type AiProviderOverrides } from "@/lib/execution-flow-settings";

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
  /** 自動化区分の「計画レビューの担当AI」リンクから、AI・モデル区分の計画レビュー欄へ移る（#4139） */
  onOpenPlanReviewSettings?: () => void;
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
// 「設定へ」で移動できる欄。計画レビュー・PRレビュー修復は「工程ごとの個別設定」にある（#4139・#5643）
const FLOW_SOURCE_IDS_AI = [
  "subpc-model-settings", "github-actions-settings", "app-ai-settings", "model-pick-settings",
  "plan-review-settings", "workflow-model-settings",
] as const;

const AI_SECTION_NAV = [
  { id: "ai-provider-settings", label: "① 共通" },
  { id: "subpc-model-settings", label: "② ローカル" },
  { id: "github-actions-settings", label: "② GitHub Actions" },
  { id: "app-ai-settings", label: "② アプリ内AI" },
  { id: "process-override-settings", label: "③ 個別設定" },
  { id: "execution-flow-summary", label: "いまの実行内容" },
] as const;

const WORKFLOW_MODEL_DEFAULTS: WorkflowModelValues = {
  workflowClaudeModel: "auto",
  workflowCodexModel: "auto",
  workflowCodexReasoningEffort: CODEX_REASONING_EFFORT_DEFAULT,
};
const FLOW_SOURCE_IDS_ALL = FLOW_SOURCE_IDS_AI;

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
  planReviewAgentForClaude: resolvedPlanReviewAgentForClaude,
  planReviewAgentForCodex: resolvedPlanReviewAgentForCodex,
  planReviewClaudeModel: initialPlanReviewClaudeModel,
  planReviewCodexModel: initialPlanReviewCodexModel,
  dispatchFailoverEnabled: initialDispatchFailoverEnabled,
  dispatchFailoverThresholdPercent: initialDispatchFailoverThresholdPercent,
  appAiModel: initialAppAiModel,
  appAiModelReasoning: initialAppAiModelReasoning,
  modelPickEngine: initialModelPickEngine,
  dispatchConcurrency: initialDispatchConcurrency,
  aiProviderOverrides = NO_AI_PROVIDER_OVERRIDES,
  onOpenPlanReviewSettings,
  onUpdated,
}: ExecutionSettingsSectionProps) {
  // 画面へ渡る担当AIは解決済みで追従か固定かが読めないため、固定の有無（overrides）と合わせて
  // 「全体設定に従う（inherit）」か固定かの選択値へ戻す（#4139）
  const initialPlanReviewAgentForClaude: PlanReviewAgentSetting =
    aiProviderOverrides.planReviewAgentForClaude ? resolvedPlanReviewAgentForClaude : AI_PROVIDER_INHERIT;
  const initialPlanReviewAgentForCodex: PlanReviewAgentSetting =
    aiProviderOverrides.planReviewAgentForCodex ? resolvedPlanReviewAgentForCodex : AI_PROVIDER_INHERIT;
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
  const [planReviewAgentForClaude, setPlanReviewAgentForClaude] = useState<PlanReviewAgentSetting>(
    initialPlanReviewAgentForClaude,
  );
  const [planReviewAgentForCodex, setPlanReviewAgentForCodex] = useState<PlanReviewAgentSetting>(
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
  // PRレビュー・修復のworkflow専用モデル（#5643で区分の保存ボタンへ統一）。画面のpropsでは渡らないため、
  // 区分を開いたときにAPIから読む。読めるまでは選べなくし、既定値で保存済みの値を上書きしない
  const [workflow, setWorkflow] = useState<WorkflowModelValues>(WORKFLOW_MODEL_DEFAULTS);
  const [savedWorkflow, setSavedWorkflow] = useState<WorkflowModelValues>(WORKFLOW_MODEL_DEFAULTS);
  const [workflowLoaded, setWorkflowLoaded] = useState(false);
  const showsAiSettings = mode === "ai" || mode === "all";
  useEffect(() => {
    if (!showsAiSettings || typeof fetch !== "function") return;
    let cancelled = false;
    fetch("/api/settings/claude-model")
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const loaded = await response.json();
        const next: WorkflowModelValues = {
          workflowClaudeModel: typeof loaded.workflowClaudeModel === "string" ? loaded.workflowClaudeModel : "auto",
          workflowCodexModel: typeof loaded.workflowCodexModel === "string" ? loaded.workflowCodexModel : "auto",
          workflowCodexReasoningEffort: typeof loaded.workflowCodexReasoningEffort === "string"
            ? loaded.workflowCodexReasoningEffort
            : CODEX_REASONING_EFFORT_DEFAULT,
        };
        if (cancelled) return;
        setWorkflow(next);
        setSavedWorkflow(next);
        setWorkflowLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showsAiSettings]);
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

  const workflowDirty =
    workflowLoaded && (
      workflow.workflowClaudeModel !== savedWorkflow.workflowClaudeModel ||
      workflow.workflowCodexModel !== savedWorkflow.workflowCodexModel ||
      workflow.workflowCodexReasoningEffort !== savedWorkflow.workflowCodexReasoningEffort
    );
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
    dispatchConcurrency !== initialDispatchConcurrency ||
    workflowDirty;

  // 計画レビューの担当AI・モデルはAI・モデル区分へ移した（#4139）。自動化区分に未保存の値は無い
  const planReviewDirty =
    planReviewAgentForClaude !== initialPlanReviewAgentForClaude ||
    planReviewAgentForCodex !== initialPlanReviewAgentForCodex ||
    planReviewClaudeModel !== initialPlanReviewClaudeModel ||
    planReviewCodexModel !== initialPlanReviewCodexModel;
  const aiDirty =
    workflowDirty ||
    aiExecutionProvider !== initialAiExecutionProvider ||
    claudeModel !== initialClaudeModel ||
    githubActionsAgent !== initialGithubActionsAgent ||
    githubActionsCodexModel !== initialGithubActionsCodexModel ||
    claudeModelAssist !== initialClaudeModelAssist ||
    claudeLocalModel !== initialClaudeLocalModel ||
    codexModel !== initialCodexModel ||
    appAiModel !== initialAppAiModel ||
    appAiModelReasoning !== initialAppAiModelReasoning ||
    modelPickEngine !== initialModelPickEngine ||
    planReviewDirty;
  const executionDirty =
    autoRetryLimit !== initialAutoRetryLimit ||
    defaultDispatchAgent !== initialDefaultDispatchAgent ||
    dispatchFailoverEnabled !== initialDispatchFailoverEnabled ||
    dispatchFailoverThresholdPercent !== initialDispatchFailoverThresholdPercent ||
    dispatchConcurrency !== initialDispatchConcurrency;
  const sectionDirty =
    mode === "ai" ? aiDirty :
    mode === "execution" ? executionDirty :
    mode === "automation" ? false :
    isDirty;


  // 画面で選び直した機能別の値は、保存すると個別設定になる。表の「追従」が保存後の実態とずれないよう、
  // 未保存でも初期値から変えた項目は個別設定として見せる
  const displayOverrides: AiProviderOverrides = {
    githubActionsAgent: aiProviderOverrides.githubActionsAgent || githubActionsAgent !== initialGithubActionsAgent,
    defaultDispatchAgent: aiProviderOverrides.defaultDispatchAgent || defaultDispatchAgent !== initialDefaultDispatchAgent,
    planReviewAgentForClaude: planReviewAgentForClaude !== AI_PROVIDER_INHERIT,
    planReviewAgentForCodex: planReviewAgentForCodex !== AI_PROVIDER_INHERIT,
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
      modelPickEngine === initialModelPickEngine &&
      !planReviewDirty &&
      !workflowDirty;
    // 担当AIは変えた項目だけ送る。解決済みの値をそのまま送ると、追従していた項目が固定に変わってしまう
    const planReviewValues = {
      ...(planReviewAgentForClaude !== initialPlanReviewAgentForClaude ? { planReviewAgentForClaude } : {}),
      ...(planReviewAgentForCodex !== initialPlanReviewAgentForCodex ? { planReviewAgentForCodex } : {}),
      ...(planReviewClaudeModel !== initialPlanReviewClaudeModel ? { planReviewClaudeModel } : {}),
      ...(planReviewCodexModel !== initialPlanReviewCodexModel ? { planReviewCodexModel } : {}),
    };
    // workflow専用モデルも変えた項目だけ送る（他の画面で保存された値を、読み込み時点の値で巻き戻さない）
    const workflowValues = workflowLoaded
      ? (Object.keys(workflow) as (keyof WorkflowModelValues)[])
          .filter((key) => workflow[key] !== savedWorkflow[key])
          .reduce<Partial<WorkflowModelValues>>((values, key) => ({ ...values, [key]: workflow[key] }), {})
      : {};
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
            ...planReviewValues,
            ...workflowValues,
          }
        : mode === "execution"
          ? {
              defaultDispatchAgent,
              dispatchFailoverEnabled,
              dispatchFailoverThresholdPercent,
            }
          : mode === "automation"
            ? {}
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
                ...planReviewValues,
                ...workflowValues,
                dispatchFailoverEnabled,
                dispatchFailoverThresholdPercent,
              };
    const claudeModelOk = await updateClaudeModel(modelValues);
    if (!claudeModelOk) return;
    if (showsAiSettings) setSavedWorkflow(workflow);
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
    // 計画レビューの担当AIだけは、送った値が`inherit`なら固定を解く（#4139）
    if ("planReviewAgentForClaude" in sent) nextOverrides.planReviewAgentForClaude = planReviewAgentForClaude !== AI_PROVIDER_INHERIT;
    if ("planReviewAgentForCodex" in sent) nextOverrides.planReviewAgentForCodex = planReviewAgentForCodex !== AI_PROVIDER_INHERIT;
    const resolvePlanReviewSelection = (selection: PlanReviewAgentSetting, source: PlanReviewAgent): PlanReviewAgent =>
      resolvePlanReviewAgent(selection, source);
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
      planReviewAgentForClaude: resolvePlanReviewSelection(mode === "ai" || mode === "all" ? planReviewAgentForClaude : initialPlanReviewAgentForClaude, "claude"),
      planReviewAgentForCodex: resolvePlanReviewSelection(mode === "ai" || mode === "all" ? planReviewAgentForCodex : initialPlanReviewAgentForCodex, "codex"),
      planReviewClaudeModel: mode === "ai" || mode === "all" ? planReviewClaudeModel : initialPlanReviewClaudeModel,
      planReviewCodexModel: mode === "ai" || mode === "all" ? planReviewCodexModel : initialPlanReviewCodexModel,
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
      appAiModel: nextOverrides.appAiModel ? saved.appAiModel : resolveAppAiModel(undefined, provider),
      appAiModelReasoning: nextOverrides.appAiModelReasoning
        ? saved.appAiModelReasoning
        : resolveAppAiModel(undefined, provider, true),
    });
    setIsSaved(true);
  }

  // AI・モデル区分で保存済みの値から変えた欄。欄の橙枠と、保存バーの「未保存の項目名」に使う（#5643）
  const aiFieldChanges = [
    { id: "ai-provider", label: "AI実行プロバイダー", changed: aiExecutionProvider !== initialAiExecutionProvider },
    { id: "claude-local-model", label: "ローカル：Claude Code", changed: claudeLocalModel !== initialClaudeLocalModel },
    { id: "codex-model", label: "ローカル：Codex CLI", changed: codexModel !== initialCodexModel },
    { id: "github-actions-agent", label: "GitHub Actions：エージェント", changed: githubActionsAgent !== initialGithubActionsAgent },
    { id: "claude-model", label: "GitHub Actions：計画・実装・レビュー", changed: claudeModel !== initialClaudeModel },
    { id: "claude-model-assist", label: "GitHub Actions：質問回答・Issue分割", changed: claudeModelAssist !== initialClaudeModelAssist },
    { id: "github-actions-codex-model", label: "GitHub Actions：Codex CLI", changed: githubActionsCodexModel !== initialGithubActionsCodexModel },
    { id: "app-ai-model", label: "アプリ内AI：要約・検索・文章整理", changed: appAiModel !== initialAppAiModel },
    { id: "app-ai-model-reasoning", label: "アプリ内AI：原因診断・新規アプリ相談", changed: appAiModelReasoning !== initialAppAiModelReasoning },
    { id: "model-pick-engine", label: "判定に使うAI", changed: modelPickEngine !== initialModelPickEngine },
    { id: "plan-review-agent-for-claude", label: "計画レビュー：担当（Claude Code）", changed: planReviewAgentForClaude !== initialPlanReviewAgentForClaude },
    { id: "plan-review-agent-for-codex", label: "計画レビュー：担当（Codex CLI）", changed: planReviewAgentForCodex !== initialPlanReviewAgentForCodex },
    { id: "plan-review-claude-model", label: "計画レビュー：Claudeのモデル", changed: planReviewClaudeModel !== initialPlanReviewClaudeModel },
    { id: "plan-review-codex-model", label: "計画レビュー：Codexのモデル", changed: planReviewCodexModel !== initialPlanReviewCodexModel },
    { id: "workflow-claude-model", label: "PRレビュー・修復：Claude", changed: workflowLoaded && workflow.workflowClaudeModel !== savedWorkflow.workflowClaudeModel },
    { id: "workflow-codex-model", label: "PRレビュー・修復：Codex", changed: workflowLoaded && workflow.workflowCodexModel !== savedWorkflow.workflowCodexModel },
    { id: "workflow-codex-reasoning", label: "PRレビュー・修復：推論強度", changed: workflowLoaded && workflow.workflowCodexReasoningEffort !== savedWorkflow.workflowCodexReasoningEffort },
  ];
  const changedAiFieldIds = new Set(aiFieldChanges.filter((field) => field.changed).map((field) => field.id));
  const dirtyAiLabels = aiFieldChanges.filter((field) => field.changed).map((field) => field.label);

  function resetAiChanges() {
    setAiExecutionProvider(initialAiExecutionProvider);
    setClaudeLocalModel(initialClaudeLocalModel);
    setCodexModel(initialCodexModel);
    setGithubActionsAgent(initialGithubActionsAgent);
    setClaudeModel(initialClaudeModel);
    setClaudeModelAssist(initialClaudeModelAssist);
    setGithubActionsCodexModel(initialGithubActionsCodexModel);
    setAppAiModel(initialAppAiModel);
    setAppAiModelReasoning(initialAppAiModelReasoning);
    setModelPickEngine(initialModelPickEngine);
    setPlanReviewAgentForClaude(initialPlanReviewAgentForClaude);
    setPlanReviewAgentForCodex(initialPlanReviewAgentForCodex);
    setPlanReviewClaudeModel(initialPlanReviewClaudeModel);
    setPlanReviewCodexModel(initialPlanReviewCodexModel);
    setWorkflow(savedWorkflow);
  }

  // 各実行場所で「いま実際に使われる」エージェント。個別に固定していなければプロバイダー（保存前の選択を含む）に従う
  const localAgent: AiExecutionProvider = displayOverrides.defaultDispatchAgent ? defaultDispatchAgent : aiExecutionProvider;
  const actionsAgent: AiExecutionProvider = displayOverrides.githubActionsAgent ? githubActionsAgent : aiExecutionProvider;
  const processOverrideCount = countProcessOverrides({ planReviewAgentForClaude, planReviewAgentForCodex, ...workflow });

  return (
    <div className="flex flex-col gap-4">
      {showsAiSettings && <>
        <AiSectionNav items={AI_SECTION_NAV} />

        <ProviderCard
          provider={aiExecutionProvider}
          savedProvider={initialAiExecutionProvider}
          onChange={setAiExecutionProvider}
        />

        <SettingsCard
          id="subpc-model-settings"
          step="2"
          icon={Laptop}
          iconClassName="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          title="ローカル実行"
          scope={<ScopeChip tone="green">DeskMini・Mac mini 共通</ScopeChip>}
          description="「実装を開始」でホストに起動するセッションのモデルです。どのホストで起動しても同じ値を使います（ホストごとには分けられません）。全リポジトリ共通です。"
        >
          <ProviderColumns
            active={localAgent}
            claude={
              <SettingField
                id="claude-local-model"
                label="計画・実装"
                changed={changedAiFieldIds.has("claude-local-model")}
                help="「実装を開始」の最初の選択。おまかせはIssueの内容から選び、モデルを選ばずに起動する経路ではSonnetで起動します。"
                hint={<>
                  「おまかせ」が効くのは「実装を開始」だけで、「ローカルで開始」・PR修正依頼の呼び戻し・一括停止からの再開など、
                  モデルを選ばずに起動する経路ではSonnetで起動します。Haikuはauto modeが動作しないため選べません（
                  <a href="https://github.com/anthropics/claude-code/issues/43235" target="_blank" rel="noreferrer" className="underline">
                    anthropics/claude-code#43235
                  </a>
                  ）。「Claude Codeに任せる」（`--model`を付けない起動）も、実際に動くモデルが分からなくなるため選べません（#2776）。
                </>}
              >
                <Select value={claudeLocalModel} onValueChange={(value) => setClaudeLocalModel(value as ClaudeLocalModelSetting)}>
                  <SelectTrigger id="claude-local-model" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CLAUDE_LOCAL_MODEL_SETTING_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </SettingField>
            }
            codex={
              <SettingField
                id="codex-model"
                label="計画・実装"
                changed={changedAiFieldIds.has("codex-model")}
                help="おまかせはSol・Terra・Lunaから選び、モデルを選ばずに起動する経路ではTerraで起動します。"
                hint={<>
                  通常はTerra、難しいIssueはSol、単純な修正を優先する場合はLunaが適しています。
                  「Codexに任せる」は、この設定でだけ選べます（「実装を開始」の初期選択はTerraになります）。
                </>}
              >
                <Select value={codexModel} onValueChange={(value) => setCodexModel(value as CodexModelSetting)}>
                  <SelectTrigger id="codex-model" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CODEX_MODEL_SETTING_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </SettingField>
            }
          />
          <p className="mt-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            既定のエージェント（Claude／Codex）・使用量に応じた自動フェイルオーバー・同時実行数は「実行」区分にあります。
          </p>
        </SettingsCard>

        <SettingsCard
          id="github-actions-settings"
          step="2"
          icon={GitBranch}
          iconClassName="bg-primary/10 text-primary"
          title="GitHub Actions"
          scope={<ScopeChip tone="primary">無人実行・ローカルとは別に保存</ScopeChip>}
          description="GitHub Actionsでの計画・実装・レビューに使います。全リポジトリ共通です。"
          aside={
            <SettingField
              id="github-actions-agent"
              label="エージェント"
              changed={changedAiFieldIds.has("github-actions-agent")}
              badge={displayOverrides.githubActionsAgent ? <ScopeChip tone="amber">個別設定</ScopeChip> : <ScopeChip tone="primary">追従</ScopeChip>}
            >
              <Select
                value={actionsAgent}
                onValueChange={(value) => setGithubActionsAgent(value as GithubActionsAgent)}
              >
                <SelectTrigger id="github-actions-agent" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{DISPATCH_AGENT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </SettingField>
          }
        >
          <ProviderColumns
            active={actionsAgent}
            claude={<>
              <SettingField
                id="claude-model"
                label="計画・実装・レビュー"
                changed={changedAiFieldIds.has("claude-model")}
                help="計画作成・計画レビュー・実装とPR作成。通常はSonnet、難しい設計を優先する場合はOpus。"
              >
                <Select value={claudeModel} onValueChange={(value) => setClaudeModel(value as ClaudeModel)}>
                  <SelectTrigger id="claude-model" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{CLAUDE_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </SettingField>
              <SettingField
                id="claude-model-assist"
                label="質問回答・Issue分割"
                changed={changedAiFieldIds.has("claude-model-assist")}
                help="質問への回答と大きなIssueの分割。通常はHaikuで十分です。"
              >
                <Select value={claudeModelAssist} onValueChange={(value) => setClaudeModelAssist(value as ClaudeModel)}>
                  <SelectTrigger id="claude-model-assist" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{CLAUDE_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </SettingField>
            </>}
            codex={
              <SettingField
                id="github-actions-codex-model"
                label="計画・実装・レビュー"
                changed={changedAiFieldIds.has("github-actions-codex-model")}
                help="エージェントをCodex CLIにしたときのモデルです。"
              >
                <Select value={githubActionsCodexModel} onValueChange={(value) => setGithubActionsCodexModel(value as CodexLocalModel)}>
                  <SelectTrigger id="github-actions-codex-model" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{CODEX_LOCAL_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </SettingField>
            }
          />
        </SettingsCard>

        <SettingsCard
          id="app-ai-settings"
          step="2"
          icon={Sparkles}
          iconClassName="bg-violet-500/15 text-violet-700 dark:text-violet-300"
          title="アプリ内AI"
          scope={<ScopeChip tone="violet">IssueDeckの画面の中</ScopeChip>}
          description="要約・検索・原因診断など、画面の中で動くAIです。選んだモデルで実行先（IssueDeckサーバーのAnthropic API／DeskMiniのCodex CLI）が決まります。"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SettingField
              id="app-ai-model"
              label="要約・検索・文章整理"
              changed={changedAiFieldIds.has("app-ai-model")}
              help="要約・類似Issue検索・本文整理・Issue作成補助・デプロイ失敗の原因分析。通常はHaikuが適しています。"
              hint={<>
                GPT系を選ぶとDeskMiniのログイン済みCodex CLI（ChatGPTサブスク枠）で実行し、Claudeが使えないときの代わりになります。
                OpenAI API（従量課金）は使わず、Codexが使えないときはエラーを表示してClaudeへは切り替えません。
                画像からの変更内容の抽出も、画像をDeskMiniへ渡してCodex CLIで読み取ります（画像は処理が終われば消えます）。モデルの自動選択はルールで判定します。
              </>}
            >
              <Select value={appAiModel} onValueChange={(value) => setAppAiModel(value as AppAiModel)}>
                <SelectTrigger id="app-ai-model" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{APP_AI_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
              <AppAiRuntimeNote model={appAiModel} />
            </SettingField>

            <SettingField
              id="app-ai-model-reasoning"
              label="原因診断・新規アプリ相談"
              changed={changedAiFieldIds.has("app-ai-model-reasoning")}
              help="手作業の原因診断・新規アプリの構成相談・修正提案・全体レビューの判断の推奨。通常はSonnetが適しています。"
              hint={<>
                GPT系を選ぶと、原因診断（チャット調査）・新規アプリ相談・手作業の修正提案・全体レビューの判断の推奨を
                DeskMiniのCodex CLI（ChatGPTサブスク枠）で実行します。OpenAI API（従量課金）は使わず、Codexが使えないときはClaudeへ切り替えません。
              </>}
            >
              <Select value={appAiModelReasoning} onValueChange={(value) => setAppAiModelReasoning(value as AppAiModel)}>
                <SelectTrigger id="app-ai-model-reasoning" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{APP_AI_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
              <AppAiRuntimeNote model={appAiModelReasoning} />
              {/* リリースPRの全体AIレビュー（#4238）の担当は、この設定で決まる。画面の表示と実際に積むジョブは同じ関数を使う */}
              <p className="text-xs text-muted-foreground" data-testid="release-review-assignee">
                リリース全体レビューの担当（実効）:{" "}
                {describeReleaseReviewAssignee(resolveReleaseReviewAssignee({ appAiModelReasoning, aiExecutionProvider }))}
                （公開承認の自動化がONの間は、この設定にかかわらずCodexで実行します）
              </p>
            </SettingField>

            {/* 判定に使うAI（#3189・#3245）。**選ばれる側のモデルではなく、選ぶ側。**
                「おまかせ」のモデル選択と、Issue作成の「タイトル自動」で付くラベルの判定の両方に効く */}
            <div id="model-pick-settings" tabIndex={-1} className="scroll-mt-2 outline-none">
              <SettingField
                id="model-pick-engine"
                label="判定に使うAI（おまかせ・ラベル付与）"
                changed={changedAiFieldIds.has("model-pick-engine")}
                help="「おまかせ」のモデル選択と、Issue作成「タイトル自動」のラベル判定に使います。"
                hint={<>
                  タイトルはどちらでもアプリ内AIが付けます。Jevは文章を書かない判定専用のモデルで、渡した候補以外を返しません。
                  選ぶとIssueのタイトル・本文・ラベル・承認済みの計画（ラベル付与では作成中の本文）がTypeSafeへ送られます
                  （privateリポジトリのIssueも対象です）。TYPESAFE_API_KEYが未設定のとき・呼び出しに失敗したときは、アプリ内AIで判定します。
                </>}
              >
                <Select value={modelPickEngine} onValueChange={(value) => setModelPickEngine(value as ModelPickEngine)}>
                  <SelectTrigger id="model-pick-engine" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{MODEL_PICK_ENGINE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
                {/* **送信先が1社増えることを、切り替えるこの場で伝える**（#3189の計画レビュー） */}
                {modelPickEngine === "jev" && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    選択中：Issueのタイトル・本文・ラベル・承認済みの計画がTypeSafeへ送られます（privateリポジトリのIssueも対象です）。
                  </p>
                )}
              </SettingField>
            </div>

            <ReleaseAutoApprovalField />
          </div>
        </SettingsCard>

        <PlanReviewSettingsBlock
          aiExecutionProvider={aiExecutionProvider}
          fixedCount={processOverrideCount}
          agentForClaude={planReviewAgentForClaude}
          agentForCodex={planReviewAgentForCodex}
          onAgentForClaudeChange={setPlanReviewAgentForClaude}
          onAgentForCodexChange={setPlanReviewAgentForCodex}
          claudeModel={planReviewClaudeModel}
          codexModel={planReviewCodexModel}
          onClaudeModelChange={setPlanReviewClaudeModel}
          onCodexModelChange={setPlanReviewCodexModel}
          workflow={workflow}
          workflowLoaded={workflowLoaded}
          onWorkflowChange={(next) => setWorkflow((current) => ({ ...current, ...next }))}
          changedIds={changedAiFieldIds}
        />

        <ExecutionFlowOverview
          aiExecutionProvider={aiExecutionProvider}
          overrides={displayOverrides}
          linkableSourceIds={mode === "all" ? FLOW_SOURCE_IDS_ALL : FLOW_SOURCE_IDS_AI}
          claudeModel={claudeModel}
          githubActionsAgent={githubActionsAgent}
          githubActionsCodexModel={githubActionsCodexModel}
          claudeModelAssist={claudeModelAssist}
          claudeLocalModel={claudeLocalModel}
          codexModel={codexModel}
          defaultDispatchAgent={defaultDispatchAgent}
          planReviewAgentForClaude={resolvePlanReviewAgent(planReviewAgentForClaude, "claude")}
          planReviewAgentForCodex={resolvePlanReviewAgent(planReviewAgentForCodex, "codex")}
          planReviewClaudeModel={planReviewClaudeModel}
          planReviewCodexModel={planReviewCodexModel}
          appAiModel={appAiModel}
          appAiModelReasoning={appAiModelReasoning}
          modelPickEngine={modelPickEngine}
          {...workflow}
        />
      </>}

      {mode === "automation" && <div id="plan-review-agent-link" className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-3 text-sm">
        <p className="text-muted-foreground">
          計画レビューの担当AI・モデルは、AI・モデル設定でまとめて変更します。ここでは有効・無効や実行条件だけを設定します。
        </p>
        {onOpenPlanReviewSettings && (
          <Button type="button" variant="link" className="h-auto w-fit px-0 text-sm" onClick={onOpenPlanReviewSettings}>
            担当AIはAIモデル設定で変更
          </Button>
        )}
      </div>}

      {(mode === "execution" || mode === "all") && <h3 className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">DeskMiniとエラー処理</h3>}

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
          <Label htmlFor="default-dispatch-agent">DeskMini：既定のエージェント</Label>
          <InfoHint label="DeskMini：既定のエージェント">
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
          <Label htmlFor="dispatch-concurrency">DeskMiniの同時実行数</Label>
          <InfoHint label="DeskMiniの同時実行数">
            DeskMiniへディスパッチしたジョブを同時に何本まで走らせるかの上限です。CPUの実力に
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

      {error && <p className="text-sm text-destructive">{error}</p>}

      {mode === "ai" && (
        <StickySaveBar
          dirtyLabels={dirtyAiLabels}
          isSubmitting={isSubmitting}
          canSave={isValid}
          isSaved={isSaved}
          onSave={handleSubmit}
          onReset={resetAiChanges}
        />
      )}

      {(mode === "execution" || mode === "all") && <div className="flex items-center gap-3 border-t pt-4">
        <Button onClick={handleSubmit} disabled={isSubmitting || !isValid || !sectionDirty}>
          {isSubmitting ? "保存中..." : "保存"}
        </Button>
        {isSaved && !sectionDirty && (
          <span className="text-xs text-muted-foreground">保存しました</span>
        )}
        {sectionDirty && !isSubmitting && (
          <span className="text-xs text-muted-foreground">未保存の変更があります</span>
        )}
      </div>}

      {(mode === "automation" || mode === "all") && <>
      {mode === "all" && <><h3 className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">自動化</h3><p className="-mt-2 text-xs text-muted-foreground">各項目の変更はその場で保存されます。</p></>}

      <CodeReviewRecommendField />

      <PlanReviewAutoReflectField />
      </>}
    </div>
  );
}

/** 選んだモデルの実際の実行先（#5067）。GPT系を「Claudeで動く代替」と誤認させない */
function AppAiRuntimeNote({ model }: { model: AppAiModel }) {
  const codex = appAiProvider(model) === "openai";
  return (
    <p className="text-xs text-muted-foreground" data-testid="app-ai-runtime">
      実行先:{" "}
      {codex
        ? "DeskMiniのCodex CLI（ChatGPTサブスク枠）。Claudeが止まっていても動きます。DeskMiniがオフライン・未ログイン・枠超過のときはエラーになります"
        : "IssueDeckサーバーからAnthropic API（Claudeのサブスク枠）"}
    </p>
  );
}
