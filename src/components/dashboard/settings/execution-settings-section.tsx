"use client";

import { useState } from "react";

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
  type AppAiModel,
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

export type AppSettingsValues = {
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
};

export type ExecutionSettingsMode = "ai" | "execution" | "automation" | "all";

export type ExecutionSettingsSectionProps = {
  /** 既存の保存APIを保ったまま、設定の目的ごとにフォームを表示する。 */
  mode?: ExecutionSettingsMode;
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
export function ExecutionSettingsSection({
  mode = "all",
  autoRetryLimit: initialAutoRetryLimit,
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
  onUpdated,
}: ExecutionSettingsSectionProps) {
  const { updateAutoRetryLimit, updateClaudeModel, updateDispatchConcurrency, isSubmitting, error } =
    useAppSettingsMutations();
  const [autoRetryLimit, setAutoRetryLimit] = useState(initialAutoRetryLimit);
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

  // フォームの初期化はマウント時のuseStateだけで済ませ、effectでの再同期は持たない。
  // このセクションは区分を切り替えるたび・設定を閉じるたびにアンマウントされるため、
  // 開き直せば必ず現在値から始まる。保存後に親から新しい値が降りてくる経路と
  // 競合しないぶん、「保存しました」の表示もそのまま残せる。

  const isValid =
    Number.isInteger(autoRetryLimit) &&
    autoRetryLimit >= AUTO_RETRY_LIMIT_MIN &&
    autoRetryLimit <= AUTO_RETRY_LIMIT_MAX &&
    Number.isInteger(dispatchConcurrency) &&
    dispatchConcurrency >= DISPATCH_CONCURRENCY_MIN &&
    dispatchConcurrency <= DISPATCH_CONCURRENCY_MAX &&
    Number.isInteger(dispatchFailoverThresholdPercent) &&
    dispatchFailoverThresholdPercent >= DISPATCH_FAILOVER_THRESHOLD_PERCENT_MIN &&
    dispatchFailoverThresholdPercent <= DISPATCH_FAILOVER_THRESHOLD_PERCENT_MAX;

  const isDirty =
    autoRetryLimit !== initialAutoRetryLimit ||
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


  async function handleSubmit() {
    setIsSaved(false);
    if (mode === "execution" || mode === "all") {
      const autoRetryOk = await updateAutoRetryLimit(autoRetryLimit);
      if (!autoRetryOk) return;
    }
    const modelValues =
      mode === "ai"
        ? {
            claudeModel,
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
    // 親へも「この区分で実際に保存した値」だけを反映する。他区分の未保存stateを
    // 保存済みpropsへ混ぜると、未保存表示が消えたり後の保存で巻き戻るため、initial値を維持する。
    onUpdated({
      autoRetryLimit: mode === "execution" || mode === "all" ? autoRetryLimit : initialAutoRetryLimit,
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
    });
    setIsSaved(true);
  }

  return (
    <div className="flex flex-col gap-4">
      {(mode === "ai" || mode === "all") && <ExecutionFlowOverview
        claudeModel={claudeModel}
        githubActionsAgent={githubActionsAgent}
        githubActionsCodexModel={githubActionsCodexModel}
        claudeModelAssist={claudeModelAssist}
        claudeLocalModel={claudeLocalModel}
        codexModel={codexModel}
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
        <Label htmlFor="auto-retry-limit">自動リトライ回数</Label>
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
        <p className="text-xs text-muted-foreground">
          GitHub
          Actionsの無人実行（Issueからの計画・実装）が、計画コメントもPull
          Requestも残せずに終わった場合に、自動で再実行する回数の上限です。0で無効ですが、一過性の障害と判定した場合だけは0でも2回まで再実行します。ローカルセッションには適用されません。全リポジトリ共通の設定です。
        </p>
      </div>}

      {(mode === "execution" || mode === "all") && <div id="subpc-agent-settings" className="flex flex-col gap-1.5 border-t pt-4">
        <Label htmlFor="default-dispatch-agent">サブPC：既定のエージェント</Label>
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
        <p className="text-xs text-muted-foreground">
          「実装を開始」を開いたときの最初の選択です。Issueごとに選び直した値、既存セッションの再開、GitHub Actionsには影響しません。
        </p>
      </div>

      {(mode === "automation" || mode === "all") && <div id="plan-review-settings" className="flex flex-col gap-3 border-t pt-4">
        <div>
          <Label>サブPC：自動計画レビューのエージェントとモデル</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            計画を出したCLIごとに、続く自動計画レビューで使うエージェントを選びます。Issue詳細から手動で始める単独レビューの選択には影響しません。
          </p>
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
          <Label htmlFor="dispatch-failover-enabled">使用量に応じた自動フェイルオーバー</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            既定のエージェントの使用率がしきい値以上なら、もう一方を「実装を開始」の最初の選択にします。
          </p>
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
          <Label htmlFor="dispatch-failover-threshold">切替しきい値（使用率）</Label>
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
          <p className="text-xs text-muted-foreground">
            使用量を取得できない・古い・期限切れの場合は切り替えません。手動で選び直したエージェントも維持します。
          </p>
        </div>
      </div>}

      {(mode === "execution" || mode === "all") && <div id="concurrency-settings" className="flex flex-col gap-1.5 border-t pt-4">
        <Label htmlFor="dispatch-concurrency">サブPCの同時実行数</Label>
        <Input
          id="dispatch-concurrency"
          type="number"
          min={DISPATCH_CONCURRENCY_MIN}
          max={DISPATCH_CONCURRENCY_MAX}
          value={dispatchConcurrency}
          onChange={(e) => setDispatchConcurrency(Number(e.target.value))}
        />
        <p className="text-xs text-muted-foreground">
          サブPCへディスパッチしたジョブを同時に何本まで走らせるかの上限です。CPUの実力に
          合わせて変えられるよう設定値にしています（既定の3は載せ替え後のCPU実測にもとづく上限で、
          4本にするとメモリが足りずビルドが2倍以上遅くなります）。
        </p>
      </div>}

      {(mode === "ai" || mode === "all") && <>
      <h3 id="github-actions-settings" className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">GitHub Actions 共通設定</h3>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="github-actions-agent">エージェント</Label>
        <Select value={githubActionsAgent} onValueChange={(value) => setGithubActionsAgent(value as GithubActionsAgent)}>
          <SelectTrigger id="github-actions-agent" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{DISPATCH_AGENT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">GitHub Actionsの計画・実装・レビューに使うCLIです。サブPCとは別に保存されます。</p>
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
        <Label htmlFor="claude-model">GitHub Actions（Claude）：計画・実装・レビュー</Label>
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
        <p className="text-xs text-muted-foreground">
          Claude Codeを選んだときに、GitHub Actionsで計画を作り、計画をレビューし、実装してPRを作る処理に使います。
          通常はSonnet、難しい設計を優先する場合はOpusが適しています。全リポジトリ共通です。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="claude-model-assist">GitHub Actions（Claude）：質問回答・Issue分割</Label>
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
        <p className="text-xs text-muted-foreground">
          GitHub Actionsで質問へ回答し、大きなIssueを分割する処理に使います。通常はHaikuで十分です。
        </p>
      </div>

      <h3 id="subpc-model-settings" className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">サブPC 共通設定</h3>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="claude-local-model">サブPC（Claude）：計画・実装</Label>
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
        <p className="text-xs text-muted-foreground">
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
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="codex-model">Codex：サブPCでの計画・実装</Label>
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
        <p className="text-xs text-muted-foreground">
          「実装を開始」でCodex CLIを選んだとき、最初から選ばれるモデルです。通常はTerra、難しい
          IssueはSol、単純な修正を優先する場合はLunaが適しています。「おまかせ」を選ぶと、開くたびに
          Issueの内容からSol・Terra・Lunaを選びます。ただし「おまかせ」が効くのは「実装を開始」だけで、
          モデルを選ばずに起動する経路（ローカルで開始など）ではTerraで起動します。
          旧世代（GPT-5.5・5.4）と「Codexに任せる」は、この設定でだけ選べます（ダイアログの初期選択は
          Terraになります）。全リポジトリ共通です。
        </p>
      </div>

      {/* 判定に使うAI（#3189・#3245）。**選ばれる側のモデルではなく、選ぶ側。**
          「おまかせ」のモデル選択と、Issue作成の「タイトル自動」で付くラベルの判定の両方に効く。
          サブPCのモデル設定（すぐ上）の直後に置く */}
      <div id="model-pick-settings" className="flex flex-col gap-1.5">
        <Label htmlFor="model-pick-engine">判定に使うAI（おまかせ・ラベル付与）</Label>
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
        <p className="text-xs text-muted-foreground">
          「実装を開始」で「おまかせ」を選んだときにモデルを選ぶ判定と、Issue作成で「タイトル自動」を
          使ったときにラベルを付ける判定に使うAIです（タイトルはどちらでもアプリ内AIが付けます）。
          Jevは文章を書かない判定専用のモデルで、渡した候補以外を返しません。
          選ぶとIssueのタイトル・本文・ラベル・承認済みの計画（ラベル付与では作成中の本文）が
          TypeSafeへ送られます（privateリポジトリのIssueも対象です）。TYPESAFE_API_KEYが未設定の
          とき・呼び出しに失敗したときは、アプリ内AIで判定します。
        </p>
      </div>

      <div id="app-ai-settings" className="flex flex-col gap-1.5">
        <Label htmlFor="app-ai-model">アプリ内AI：要約・検索・文章整理</Label>
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
        <p className="text-xs text-muted-foreground">
          Issueとコメントの要約、類似Issue検索、本文整理、並び替え、Issue作成補助に使います。
          定型処理が中心のため、通常はHaikuが適しています。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="app-ai-model-reasoning">アプリ内AI：原因診断・新規アプリ相談</Label>
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
        <p className="text-xs text-muted-foreground">
          手作業が失敗した原因の診断と、新規アプリの構成相談に使います。判断力が必要なため、
          通常はSonnetが適しています。GPTを選ぶとOpenAI API、Claudeを選ぶとAnthropic APIを使います。
        </p>
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
      </div>}

      {(mode === "automation" || mode === "all") && <>
      {mode === "all" && <><h3 className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">自動化</h3><p className="-mt-2 text-xs text-muted-foreground">各項目の変更はその場で保存されます。</p></>}

      <ReleasePrepIntervalField />

      <CodeReviewRecommendField />

      <PlanReviewAutoReflectField />
      </>}
    </div>
  );
}
