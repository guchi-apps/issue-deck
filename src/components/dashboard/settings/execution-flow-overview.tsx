"use client";

import { Fragment, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InfoHint } from "@/components/dashboard/settings/info-hint";
import { cn } from "@/lib/utils";
import {
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DISPATCH_AGENT_OPTIONS,
  type AiExecutionProvider,
  type ClaudeModel,
  type CodexModel,
  type CodexReasoningEffort,
} from "@/lib/app-settings";
import {
  resolveProviderFlowRows,
  type AiProviderOverrides,
  type ProviderFlowBinding,
  type ProviderFlowSettings,
} from "@/lib/execution-flow-settings";

type ExecutionFlowOverviewProps = ProviderFlowSettings & {
  aiExecutionProvider: AiExecutionProvider;
  /** 保存済みのプロバイダー。選択中の値と違えば未保存と出す */
  savedAiExecutionProvider: AiExecutionProvider;
  onAiExecutionProviderChange: (provider: AiExecutionProvider) => void;
  overrides: AiProviderOverrides;
  /** この画面に置かれている設定欄のid。無い欄へは「設定へ」を出さない */
  linkableSourceIds: readonly string[];
};

const BINDING_LABELS: Record<ProviderFlowBinding, { label: string; className: string; description: string }> = {
  provider: {
    label: "追従",
    className: "bg-primary/10 text-primary",
    description: "プロバイダーの切替で変わります",
  },
  override: {
    label: "個別設定",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    description: "個別に固定しているため、プロバイダーを切り替えても変わりません",
  },
  implementation: {
    label: "実装に追従",
    className: "border bg-muted text-muted-foreground",
    description: "その前に実装したエージェントの側で動きます",
  },
  independent: {
    label: "固定",
    className: "border bg-muted text-muted-foreground",
    description: "プロバイダーと関係しない設定です",
  },
};

function BindingBadge({ binding }: { binding: ProviderFlowBinding }) {
  const { label, className, description } = BINDING_LABELS[binding];
  return (
    <span title={description} className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold", className)}>
      {label}
    </span>
  );
}

function providerName(provider: AiExecutionProvider) {
  return provider === "claude" ? "Claude" : "Codex";
}

/**
 * AI実行プロバイダーの切替と、その選択で各工程が何で動くかを1枚で見せる（#4108）。
 *
 * 工程の並びはClaude・Codexで変えず、切替の結果は保存前でもその場で表へ反映する。
 * workflow専用のPRレビュー・修復モデルだけは、行の「変更」からここで保存する（即時保存）。
 */
export function ExecutionFlowOverview({
  aiExecutionProvider,
  savedAiExecutionProvider,
  onAiExecutionProviderChange,
  overrides,
  linkableSourceIds,
  ...settings
}: ExecutionFlowOverviewProps) {
  const [editingWorkflow, setEditingWorkflow] = useState(false);
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>(settings.workflowClaudeModel ?? "auto");
  const [codexModel, setCodexModel] = useState<CodexModel>(settings.workflowCodexModel ?? "auto");
  const [reasoningEffort, setReasoningEffort] = useState<CodexReasoningEffort>(settings.workflowCodexReasoningEffort ?? "default");
  const [saved, setSaved] = useState({ claudeModel, codexModel, reasoningEffort });
  const [isSaving, setIsSaving] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(settings.workflowClaudeModel !== undefined);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (settings.workflowClaudeModel !== undefined) return;
    void fetch("/api/settings/claude-model").then(async (response) => {
      if (!response.ok) return;
      const loaded = await response.json();
      const next = {
        claudeModel: typeof loaded.workflowClaudeModel === "string" ? loaded.workflowClaudeModel as ClaudeModel : "auto",
        codexModel: typeof loaded.workflowCodexModel === "string" ? loaded.workflowCodexModel as CodexModel : "auto",
        reasoningEffort: typeof loaded.workflowCodexReasoningEffort === "string" ? loaded.workflowCodexReasoningEffort as CodexReasoningEffort : "default",
      } as const;
      setClaudeModel(next.claudeModel);
      setCodexModel(next.codexModel);
      setReasoningEffort(next.reasoningEffort);
      setSaved(next);
      setSettingsLoaded(true);
    }).catch(() => setSettingsLoaded(false));
  }, [settings.workflowClaudeModel]);

  // 表示は保存済みのworkflow設定で解決する（編集中の未保存値で表の内容を変えない）
  const rows = resolveProviderFlowRows(
    {
      ...settings,
      workflowClaudeModel: saved.claudeModel,
      workflowCodexModel: saved.codexModel,
      workflowCodexReasoningEffort: saved.reasoningEffort,
    },
    aiExecutionProvider,
    overrides,
  );
  const providerDirty = aiExecutionProvider !== savedAiExecutionProvider;

  async function saveWorkflowSettings() {
    setIsSaving(true);
    setSaveError(null);
    // 変えた項目だけを送る（他の画面で保存された値を、読み込み時点の値で巻き戻さない）
    const body = {
      ...(claudeModel !== saved.claudeModel ? { workflowClaudeModel: claudeModel } : {}),
      ...(codexModel !== saved.codexModel ? { workflowCodexModel: codexModel } : {}),
      ...(reasoningEffort !== saved.reasoningEffort ? { workflowCodexReasoningEffort: reasoningEffort } : {}),
    };
    try {
      if (Object.keys(body).length > 0) {
        const response = await fetch("/api/settings/claude-model", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error("保存に失敗しました");
      }
      setSaved({ claudeModel, codexModel, reasoningEffort });
      setEditingWorkflow(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setIsSaving(false);
    }
  }

  function jumpTo(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.querySelector<HTMLElement>("button, input, [role=combobox]")?.focus({ preventScroll: true });
  }

  return (
    <section aria-labelledby="ai-execution-provider" className="rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1.5">
          <h3 id="ai-execution-provider" className="font-medium">AI実行プロバイダー</h3>
          <InfoHint label="AI実行プロバイダー">
            新しく開始するIssue実装・レビュー・アプリ内AIの既定実行先です。個別に固定した設定は変更しません。
          </InfoHint>
        </div>
        <div role="group" aria-label="AI実行プロバイダー" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:inline-grid">
          {DISPATCH_AGENT_OPTIONS.map((option) => {
            const selected = aiExecutionProvider === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => onAiExecutionProviderChange(option.value)}
                className={cn(
                  "rounded-md px-6 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {providerName(option.value)}
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
        {providerDirty
          ? <><span className="font-semibold text-amber-700 dark:text-amber-300">未保存</span>：保存すると{providerName(aiExecutionProvider)}に切り替わります。</>
          : <>現在: {providerName(aiExecutionProvider)}。</>}
        切替は次に開始する処理から適用されます。
      </p>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="表示の見方">
        {(["provider", "override", "implementation"] as const).map((binding) => (
          <li key={binding} className="flex items-center gap-1.5"><BindingBadge binding={binding} />{BINDING_LABELS[binding].description}</li>
        ))}
      </ul>

      <ol className="mt-3 flex flex-col border-t" aria-label={`${providerName(aiExecutionProvider)}を選んだときの各工程`}>
        {rows.map((row) => (
          <Fragment key={row.step}>
            <li className="grid grid-cols-1 gap-1.5 border-b py-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto] sm:gap-3">
              <span className="text-sm font-semibold sm:pt-0.5">{row.step}</span>
              <div className="flex min-w-0 flex-col gap-1.5">
                {row.entries.map((entry) => (
                  <div key={entry.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5 text-sm sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                    <span className="col-span-2 text-[11px] text-muted-foreground sm:col-span-1">{entry.label}</span>
                    <span className="min-w-0 break-words">
                      <span className="text-muted-foreground">{entry.agent} / </span>
                      <span className="font-semibold">{entry.model}</span>
                      {entry.reasoningEffort && <span className="ml-1 text-[11px] text-muted-foreground">推論強度 {entry.reasoningEffort}</span>}
                      {entry.note && <span className="ml-1 inline-flex align-middle"><InfoHint label={`${row.step}（${entry.label}）`}>{entry.note}</InfoHint></span>}
                    </span>
                    <BindingBadge binding={entry.binding} />
                  </div>
                ))}
              </div>
              <div className="sm:pt-0.5">
                {row.editsWorkflowModels ? (
                  <Button
                    type="button" variant="link" className="h-auto px-0 text-xs"
                    aria-expanded={editingWorkflow}
                    aria-controls="workflow-model-editor"
                    disabled={!settingsLoaded}
                    onClick={() => setEditingWorkflow((value) => !value)}
                  >
                    変更
                  </Button>
                ) : linkableSourceIds.includes(row.sourceId) ? (
                  <Button type="button" variant="link" className="h-auto px-0 text-xs" onClick={() => jumpTo(row.sourceId)}>
                    設定へ
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">「自動化」で変更</span>
                )}
              </div>
            </li>
            {row.step === "レビュー修復" && editingWorkflow && (
              <li id="workflow-model-editor" className="flex flex-col gap-2 border-b bg-muted/30 px-3 py-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold">PRレビュー・修復のモデル</span>
                  <InfoHint label="PRレビュー・修復のモデル">
                    PRレビューとレビュー指摘修正のworkflow専用の設定です。Claudeの設定はClaude実装のレビュー指摘修正・CI自動修正・コンフリクト解消・PR repairで共有します。Codexの設定は、Codexで実装したIssueのレビュー指摘をサブPCのChatGPT購読認証で修正するときに使います（APIキーは不要）。デフォルトを選ぶと個別指定を解除します。
                  </InfoHint>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="workflow-claude-model">Claude</Label>
                    <Select value={claudeModel} onValueChange={(value) => setClaudeModel(value as ClaudeModel)}>
                      <SelectTrigger id="workflow-claude-model" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{CLAUDE_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="workflow-codex-model">Codex</Label>
                    <Select value={codexModel} onValueChange={(value) => setCodexModel(value as CodexModel)}>
                      <SelectTrigger id="workflow-codex-model" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{CODEX_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="workflow-codex-reasoning">Codexの推論強度</Label>
                    <Select value={reasoningEffort} onValueChange={(value) => setReasoningEffort(value as CodexReasoningEffort)}>
                      <SelectTrigger id="workflow-codex-reasoning" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{CODEX_REASONING_EFFORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">ここは即時保存です。保存すると、次回のworkflow実行から反映されます。</p>
                <div className="flex items-center gap-3">
                  <Button type="button" size="sm" onClick={saveWorkflowSettings} disabled={isSaving || !settingsLoaded}>{isSaving ? "保存中…" : "保存"}</Button>
                  {saveError && <p className="text-xs text-destructive">{saveError}</p>}
                </div>
              </li>
            )}
          </Fragment>
        ))}
      </ol>
    </section>
  );
}
