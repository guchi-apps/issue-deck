"use client";

import { InfoHint } from "@/components/dashboard/settings/info-hint";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AI_PROVIDER_INHERIT,
  CLAUDE_LOCAL_MODEL_OPTIONS,
  CODEX_LOCAL_MODEL_OPTIONS,
  DISPATCH_AGENT_OPTIONS,
  type AiExecutionProvider,
  type ClaudeLocalModel,
  type CodexLocalModel,
  type PlanReviewAgentSetting,
} from "@/lib/app-settings";
import {
  resolveProviderFlowRows,
  type AiProviderOverrides,
  type ProviderFlowSettings,
} from "@/lib/execution-flow-settings";

type PlanReviewSettingsBlockProps = {
  aiExecutionProvider: AiExecutionProvider;
  savedAiExecutionProvider: AiExecutionProvider;
  /** 表示の解決に使う設定。上の工程表と同じ関数で解くので、結果が食い違わない */
  flowSettings: ProviderFlowSettings;
  overrides: AiProviderOverrides;
  agentForClaude: PlanReviewAgentSetting;
  agentForCodex: PlanReviewAgentSetting;
  onAgentForClaudeChange: (value: PlanReviewAgentSetting) => void;
  onAgentForCodexChange: (value: PlanReviewAgentSetting) => void;
  claudeModel: ClaudeLocalModel;
  codexModel: CodexLocalModel;
  onClaudeModelChange: (value: ClaudeLocalModel) => void;
  onCodexModelChange: (value: CodexLocalModel) => void;
};

function providerName(provider: AiExecutionProvider) {
  return provider === "claude" ? "Claude" : "Codex";
}

function AgentSelect({
  id, label, value, onChange,
}: { id: string; label: string; value: PlanReviewAgentSetting; onChange: (value: PlanReviewAgentSetting) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(next) => onChange(next as PlanReviewAgentSetting)}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={AI_PROVIDER_INHERIT}>全体設定に従う</SelectItem>
          {DISPATCH_AGENT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}に固定</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * サブPCの自動計画レビューの担当AIとモデル（#4139）。
 *
 * 通常は「全体設定に従う」で、AI実行プロバイダーを切り替えるだけで担当CLIとモデルが切り替わる。
 * Claude用・Codex用のモデルは別々に保持するので、切り替えて戻しても値は失われない。
 * 担当AIの個別固定は詳細設定へ寄せ、「全体設定に従う」へ戻せるようにする。
 */
export function PlanReviewSettingsBlock({
  aiExecutionProvider, savedAiExecutionProvider, flowSettings, overrides,
  agentForClaude, agentForCodex, onAgentForClaudeChange, onAgentForCodexChange,
  claudeModel, codexModel, onClaudeModelChange, onCodexModelChange,
}: PlanReviewSettingsBlockProps) {
  const row = resolveProviderFlowRows(flowSettings, aiExecutionProvider, overrides).find((candidate) => candidate.step === "計画レビュー");
  const anyFixed = agentForClaude !== AI_PROVIDER_INHERIT || agentForCodex !== AI_PROVIDER_INHERIT;

  return (
    <section id="plan-review-settings" aria-labelledby="plan-review-settings-title" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-1.5">
        <h3 id="plan-review-settings-title" className="font-medium">計画レビュー</h3>
        <InfoHint label="計画レビュー">
          ローカルセッションが計画を投稿した後の自動計画レビューに使うAIです。通常は全体のClaude／Codex切替に従い、
          ClaudeならサブPCのClaude Codeと「Claude用モデル」、CodexならサブPCのCodex CLIと「Codex用モデル」で動きます。
          Issue詳細から手動で始める単独レビューには影響せず、実行中のレビューは途中で変わりません（次の新規レビューから適用）。
        </InfoHint>
      </div>

      <div className="rounded-md bg-muted/40 px-3 py-2 text-sm" aria-live="polite">
        <p className="text-[11px] text-muted-foreground">
          {providerName(aiExecutionProvider)}を選んだときの実行内容
          {aiExecutionProvider !== savedAiExecutionProvider && "（未保存）"}
        </p>
        {row?.entries.map((entry) => (
          <p key={entry.label} className="break-words">
            <span className="text-muted-foreground">{entry.label}：{entry.agent} / </span>
            <span className="font-semibold">{entry.model}</span>
            <span className="ml-2 rounded-full bg-primary/10 px-2 py-px text-[11px] font-semibold text-primary">
              {entry.binding === "override" ? "個別設定" : "全体設定に従う"}
            </span>
          </p>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-review-claude-model">Claudeで動かすときのモデル</Label>
          <Select value={claudeModel} onValueChange={(value) => onClaudeModelChange(value as ClaudeLocalModel)}>
            <SelectTrigger id="plan-review-claude-model" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CLAUDE_LOCAL_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-review-codex-model">Codexで動かすときのモデル</Label>
          <Select value={codexModel} onValueChange={(value) => onCodexModelChange(value as CodexLocalModel)}>
            <SelectTrigger id="plan-review-codex-model" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CODEX_LOCAL_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <details open={anyFixed} className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">
          詳細設定：担当AIの個別設定
          {anyFixed && <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-px text-[11px] font-semibold text-amber-700 dark:text-amber-300">個別設定あり</span>}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          計画を出したCLIごとに担当AIを固定できます。固定すると全体のClaude／Codex切替に追従しなくなります。通常は「全体設定に従う」のままにします。
        </p>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <AgentSelect id="plan-review-agent-for-claude" label="Claude Codeで計画を出したとき" value={agentForClaude} onChange={onAgentForClaudeChange} />
          <AgentSelect id="plan-review-agent-for-codex" label="Codex CLIで計画を出したとき" value={agentForCodex} onChange={onAgentForCodexChange} />
        </div>
      </details>
    </section>
  );
}
