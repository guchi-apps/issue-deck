"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORT_OPTIONS, type ClaudeModel, type CodexModel, type CodexReasoningEffort } from "@/lib/app-settings";
import { resolveExecutionFlows, type ExecutionFlowSettings } from "@/lib/execution-flow-settings";

type ExecutionFlowOverviewProps = ExecutionFlowSettings;
const GROUPS = ["計画", "実装", "レビュー", "修復", "アプリ内AI", "判定"] as const;

/** 実行場所とエージェントは閲覧専用のまま、workflow専用のAI設定だけをカード内で変更する。 */
export function ExecutionFlowOverview(props: ExecutionFlowOverviewProps) {
  const [editing, setEditing] = useState<"claude" | "codex" | null>(null);
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>(props.workflowClaudeModel ?? "auto");
  const [codexModel, setCodexModel] = useState<CodexModel>(props.workflowCodexModel ?? "auto");
  const [reasoningEffort, setReasoningEffort] = useState<CodexReasoningEffort>(props.workflowCodexReasoningEffort ?? "default");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (props.workflowClaudeModel !== undefined) return;
    void fetch("/api/settings/claude-model").then(async (response) => {
      if (!response.ok) return;
      const settings = await response.json();
      if (typeof settings.workflowClaudeModel === "string") setClaudeModel(settings.workflowClaudeModel as ClaudeModel);
      if (typeof settings.workflowCodexModel === "string") setCodexModel(settings.workflowCodexModel as CodexModel);
      if (typeof settings.workflowCodexReasoningEffort === "string") setReasoningEffort(settings.workflowCodexReasoningEffort as CodexReasoningEffort);
    }).catch(() => undefined);
  }, [props.workflowClaudeModel]);
  const flows = resolveExecutionFlows({ ...props, workflowClaudeModel: claudeModel, workflowCodexModel: codexModel, workflowCodexReasoningEffort: reasoningEffort });

  async function saveWorkflowSettings() {
    setIsSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/settings/claude-model", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowClaudeModel: claudeModel, workflowCodexModel: codexModel, workflowCodexReasoningEffort: reasoningEffort }),
      });
      if (!response.ok) throw new Error("保存に失敗しました");
      setEditing(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存に失敗しました");
    } finally {
      setIsSaving(false);
    }
  }

  return <section aria-labelledby="execution-flows-heading" className="flex flex-col gap-4">
    <div><h3 id="execution-flows-heading" className="text-sm font-semibold">実行フロー</h3><p className="mt-1 text-xs text-muted-foreground">実行場所とエージェントは参照専用です。PRレビュー・修復のモデルはカード内で変更できます。</p></div>
    {GROUPS.map((group) => {
      const groupFlows = flows.filter((flow) => flow.group === group);
      if (!groupFlows.length) return null;
      return <div key={group} className="flex flex-col gap-2"><h4 className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">{group}</h4>
        {groupFlows.map((flow) => {
          const editable = flow.sourceId === "workflow-model-settings";
          const kind = flow.agent === "Codex Action" ? "codex" : "claude";
          return <article key={`${flow.name}-${flow.agent}`} className="rounded-lg border bg-card p-3 text-sm">
            <h5 className="font-medium">{flow.name}</h5>
            <dl className="mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs"><dt className="text-muted-foreground">実行場所</dt><dd>{flow.location}</dd><dt className="text-muted-foreground">エージェント</dt><dd>{flow.agent}</dd>{flow.setting && <><dt className="text-muted-foreground">設定値</dt><dd>{flow.setting}</dd></>}<dt className="text-muted-foreground">実効モデル</dt><dd className="font-medium">{flow.model}</dd>{flow.reasoningEffort && <><dt className="text-muted-foreground">推論強度</dt><dd>{flow.reasoningEffort}</dd></>}</dl>
            {editable && <Button type="button" variant="link" className="mt-1 h-auto px-0 text-xs" onClick={() => setEditing(editing === kind ? null : kind)}><Pencil className="mr-1 size-3" />変更</Button>}
            {editable && editing === kind && <div className="mt-3 flex flex-col gap-2 border-t pt-3">{kind === "claude" ? <><Label htmlFor="workflow-claude-model">モデル</Label><Select value={claudeModel} onValueChange={(value) => setClaudeModel(value as ClaudeModel)}><SelectTrigger id="workflow-claude-model"><SelectValue /></SelectTrigger><SelectContent>{CLAUDE_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></> : <><Label htmlFor="workflow-codex-model">モデル</Label><Select value={codexModel} onValueChange={(value) => setCodexModel(value as CodexModel)}><SelectTrigger id="workflow-codex-model"><SelectValue /></SelectTrigger><SelectContent>{CODEX_MODEL_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select><Label htmlFor="workflow-codex-reasoning">推論強度</Label><Select value={reasoningEffort} onValueChange={(value) => setReasoningEffort(value as CodexReasoningEffort)}><SelectTrigger id="workflow-codex-reasoning"><SelectValue /></SelectTrigger><SelectContent>{CODEX_REASONING_EFFORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></>}<p className="text-xs text-muted-foreground">保存すると、次回のworkflow実行から反映されます。デフォルトを選ぶと個別指定を解除します。</p><Button type="button" size="sm" onClick={saveWorkflowSettings} disabled={isSaving}>{isSaving ? "保存中…" : "保存"}</Button>{saveError && <p className="text-xs text-destructive">{saveError}</p>}</div>}
            {flow.note && <p className="mt-2 border-t pt-2 text-xs leading-relaxed text-muted-foreground">{flow.note}</p>}
          </article>;
        })}
      </div>;
    })}
  </section>;
}
