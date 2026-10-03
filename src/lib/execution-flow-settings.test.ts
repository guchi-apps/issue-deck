import { describe, expect, it } from "vitest";

import { resolveExecutionFlows } from "@/lib/execution-flow-settings";

const settings = {
  claudeModel: "sonnet",
  githubActionsAgent: "claude",
  githubActionsCodexModel: "gpt-5.6-terra",
  claudeModelAssist: "haiku",
  claudeLocalModel: "pick",
  codexModel: "pick",
  planReviewAgentForClaude: "codex",
  planReviewAgentForCodex: "claude",
  planReviewClaudeModel: "opus",
  planReviewCodexModel: "gpt-6-sol",
  appAiModel: "claude-haiku-4-5",
  appAiModelReasoning: "gpt-6-sol",
  modelPickEngine: "jev",
} as const;

describe("resolveExecutionFlows", () => {
  it("設定キーではなく実行経路ごとに、場所・エージェント・実効モデルを返す", () => {
    const flows = resolveExecutionFlows(settings);

    expect(flows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "通常実装・追加修正（無人実行）",
        location: "GitHub Actions",
        agent: "Claude Code",
        model: "Sonnet 5.5",
      }),
      expect.objectContaining({
        name: "自動計画レビュー（Claude Codeで開始後）",
        location: "サブPC",
        agent: "Codex CLI",
        model: "GPT-6 Sol",
      }),
      expect.objectContaining({
        name: "おまかせのモデル選択・Issueラベル判定",
        location: "TypeSafe",
        agent: "Jev",
      }),
    ]));
  });

  it("おまかせは決定時期と、ダイアログを通らない経路のフォールバックを明示する", () => {
    const flows = resolveExecutionFlows(settings);
    const claude = flows.find((flow) => flow.name === "通常実装・セッション継続（Claude）");
    const codex = flows.find((flow) => flow.name === "通常実装・セッション継続（Codex）");

    expect(claude?.model).toBe("おまかせ（実装開始時に判定）");
    expect(claude?.note).toContain("Sonnet 5.5 にフォールバック");
    expect(codex?.note).toContain("GPT-5.6 Terra にフォールバック");
  });
});
