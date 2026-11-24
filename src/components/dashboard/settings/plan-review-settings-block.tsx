"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import { ScopeChip, SettingField } from "@/components/dashboard/settings/ai-model-layout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  AI_PROVIDER_INHERIT,
  CLAUDE_LOCAL_MODEL_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_LOCAL_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DISPATCH_AGENT_OPTIONS,
  oppositeDispatchAgent,
  type AiExecutionProvider,
  type ClaudeLocalModel,
  type ClaudeModel,
  type CodexLocalModel,
  type CodexModel,
  type CodexReasoningEffort,
  type PlanReviewAgentSetting,
} from "@/lib/app-settings";

export type WorkflowModelValues = {
  workflowClaudeModel: ClaudeModel;
  workflowCodexModel: CodexModel;
  workflowCodexReasoningEffort: CodexReasoningEffort;
};

type ProcessOverrideSettingsBlockProps = {
  /** 計画レビューは全体プロバイダーに追従しなくなったため未使用（呼び出し側の互換のため残す） */
  aiExecutionProvider?: AiExecutionProvider;
  /** 全体設定から外して固定している項目の数（`countProcessOverrides`） */
  fixedCount: number;
  agentForClaude: PlanReviewAgentSetting;
  agentForCodex: PlanReviewAgentSetting;
  onAgentForClaudeChange: (value: PlanReviewAgentSetting) => void;
  onAgentForCodexChange: (value: PlanReviewAgentSetting) => void;
  claudeModel: ClaudeLocalModel;
  codexModel: CodexLocalModel;
  onClaudeModelChange: (value: ClaudeLocalModel) => void;
  onCodexModelChange: (value: CodexLocalModel) => void;
  workflow: WorkflowModelValues;
  /** workflow専用モデルを読み込めたか。読めていない間は、既定値で上書きしないよう選べなくする */
  workflowLoaded: boolean;
  onWorkflowChange: (next: Partial<WorkflowModelValues>) => void;
  /** 保存済みの値から変えた欄のid */
  changedIds: ReadonlySet<string>;
};

function providerName(provider: AiExecutionProvider) {
  return provider === "claude" ? "Claude" : "Codex";
}

function AgentSelect({
  id, label, value, source, changed, onChange,
}: {
  id: string;
  label: string;
  value: PlanReviewAgentSetting;
  /** 計画を出した側。未固定のときの担当は、その反対側になる（#5648） */
  source: AiExecutionProvider;
  changed: boolean;
  onChange: (value: PlanReviewAgentSetting) => void;
}) {
  const fixed = value !== AI_PROVIDER_INHERIT;
  return (
    <SettingField
      id={id}
      label={label}
      changed={changed}
      badge={fixed ? <ScopeChip tone="amber">個別設定</ScopeChip> : <ScopeChip tone="muted">開始元と別のエージェント</ScopeChip>}
    >
      <Select value={value} onValueChange={(next) => onChange(next as PlanReviewAgentSetting)}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={AI_PROVIDER_INHERIT}>開始元と別のエージェント（いまは{providerName(oppositeDispatchAgent(source))}）</SelectItem>
          {DISPATCH_AGENT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}に固定</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingField>
  );
}

/**
 * ③ 工程ごとの個別設定（#4139・#5643）。
 *
 * 計画レビューの担当AI・モデルと、PRレビュー・修復のworkflow専用モデルをまとめて畳む。通常は全体設定
 * （AI実行プロバイダー）に従うので開く必要は無く、固定している項目があるときだけ見出しに件数を出して開いておく。
 * 以前はPRレビュー・修復だけが即時保存だったが、区分の保存ボタンへ揃えた。
 */
export function PlanReviewSettingsBlock({
  fixedCount,
  agentForClaude, agentForCodex, onAgentForClaudeChange, onAgentForCodexChange,
  claudeModel, codexModel, onClaudeModelChange, onCodexModelChange,
  workflow, workflowLoaded, onWorkflowChange, changedIds,
}: ProcessOverrideSettingsBlockProps) {
  // 開閉は利用者の操作に任せる。保存で固定が外れた瞬間に閉じたりしないよう、初期値だけを件数から決める
  const [open, setOpen] = useState(fixedCount > 0);
  return (
    <section id="process-override-settings" tabIndex={-1} aria-labelledby="process-override-settings-title" className="scroll-mt-2 rounded-lg border bg-card outline-none">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group p-4">
        <summary className="flex cursor-pointer list-none items-start gap-2.5 [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <SlidersHorizontal className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">3</span>
              <span id="process-override-settings-title" className="font-medium">工程ごとの個別設定</span>
              {fixedCount > 0
                ? <ScopeChip tone="amber">{fixedCount}件を個別に固定中</ScopeChip>
                : <ScopeChip tone="muted">すべて全体設定に従う</ScopeChip>}
            </span>
            <span className="text-xs text-muted-foreground">
              計画レビューの担当と、PRレビュー・修復のモデル。ここで固定した工程は、プロバイダーを切り替えても変わりません。通常は変更不要です。
            </span>
          </span>
          <span className="shrink-0 text-xs text-primary">
            <span className="group-open:hidden">開く</span>
            <span className="hidden group-open:inline">閉じる</span>
          </span>
        </summary>

        <div id="plan-review-settings" tabIndex={-1} className="mt-4 flex scroll-mt-2 flex-col gap-3 border-t pt-3 outline-none">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">計画レビュー</h4>
            <ScopeChip tone="muted">ローカルで計画を投稿したときに別のAIが確認する</ScopeChip>
          </div>
          <p className="-mt-1 text-[11px] text-muted-foreground">
            Issue詳細から手動で始める単独レビューには影響せず、実行中のレビューは途中で変わりません（次の新規レビューから適用）。
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <AgentSelect
              id="plan-review-agent-for-claude" label="担当（Claude Codeで計画を出したとき）"
              value={agentForClaude} source="claude"
              changed={changedIds.has("plan-review-agent-for-claude")} onChange={onAgentForClaudeChange}
            />
            <AgentSelect
              id="plan-review-agent-for-codex" label="担当（Codex CLIで計画を出したとき）"
              value={agentForCodex} source="codex"
              changed={changedIds.has("plan-review-agent-for-codex")} onChange={onAgentForCodexChange}
            />
            <SettingField id="plan-review-claude-model" label="Claudeで動かすときのモデル" changed={changedIds.has("plan-review-claude-model")}>
              <Select value={claudeModel} onValueChange={(value) => onClaudeModelChange(value as ClaudeLocalModel)}>
                <SelectTrigger id="plan-review-claude-model" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLAUDE_LOCAL_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </SettingField>
            <SettingField id="plan-review-codex-model" label="Codexで動かすときのモデル" changed={changedIds.has("plan-review-codex-model")}>
              <Select value={codexModel} onValueChange={(value) => onCodexModelChange(value as CodexLocalModel)}>
                <SelectTrigger id="plan-review-codex-model" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CODEX_LOCAL_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </SettingField>
          </div>
        </div>

        <div id="workflow-model-settings" tabIndex={-1} className="mt-4 flex scroll-mt-2 flex-col gap-3 border-t pt-3 outline-none">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">PRレビュー・レビュー修復</h4>
            <ScopeChip tone="muted">実装したエージェントの側で動く</ScopeChip>
          </div>
          <p className="-mt-1 text-[11px] text-muted-foreground">
            PRレビューと、レビュー指摘修正・CI自動修正・コンフリクト解消・PR repairに使います。Codexの設定は、Codexで実装したIssueの
            レビュー指摘をDeskMiniのChatGPT購読認証で修正するときに使います（APIキーは不要）。「任せる」「既定」で個別指定を解除します。
          </p>
          <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-3", !workflowLoaded && "opacity-60")}>
            <SettingField id="workflow-claude-model" label="Claude" changed={changedIds.has("workflow-claude-model")}>
              <Select disabled={!workflowLoaded} value={workflow.workflowClaudeModel} onValueChange={(value) => onWorkflowChange({ workflowClaudeModel: value as ClaudeModel })}>
                <SelectTrigger id="workflow-claude-model" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{CLAUDE_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </SettingField>
            <SettingField id="workflow-codex-model" label="Codex" changed={changedIds.has("workflow-codex-model")}>
              <Select disabled={!workflowLoaded} value={workflow.workflowCodexModel} onValueChange={(value) => onWorkflowChange({ workflowCodexModel: value as CodexModel })}>
                <SelectTrigger id="workflow-codex-model" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{CODEX_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </SettingField>
            <SettingField id="workflow-codex-reasoning" label="Codexの推論強度" changed={changedIds.has("workflow-codex-reasoning")}>
              <Select disabled={!workflowLoaded} value={workflow.workflowCodexReasoningEffort} onValueChange={(value) => onWorkflowChange({ workflowCodexReasoningEffort: value as CodexReasoningEffort })}>
                <SelectTrigger id="workflow-codex-reasoning" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{CODEX_REASONING_EFFORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </SettingField>
          </div>
        </div>
      </details>
    </section>
  );
}
