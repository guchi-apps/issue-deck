import { describe, expect, it } from "vitest";

import {
  NO_AI_PROVIDER_OVERRIDES,
  readAiProviderOverrides,
  resolveExecutionFlows,
  resolveProviderFlowRows,
} from "@/lib/execution-flow-settings";

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

describe("原因診断の実行基盤表示（#4143）", () => {
  const find = (flows: ReturnType<typeof resolveExecutionFlows>, name: string) => flows.find((flow) => flow.name === name)!;

  it("GPT系はチャット調査だけCodex CLI、新規アプリ相談はOpenAI API従量課金と明示する", () => {
    const flows = resolveExecutionFlows({ ...settings, appAiModelReasoning: "gpt-5.6-terra" });
    expect(find(flows, "原因診断（チャット調査）")).toEqual(
      expect.objectContaining({ location: "サブPC", agent: "Codex CLI（ChatGPTサブスク）" }),
    );
    expect(find(flows, "新規アプリ相談・手作業の修正提案")).toEqual(
      expect.objectContaining({ location: "IssueDeckサーバー", agent: "OpenAI API（従量課金）" }),
    );
  });

  it("Claude系はどちらもAnthropic API", () => {
    const flows = resolveExecutionFlows({ ...settings, appAiModelReasoning: "claude-sonnet-5-5" });
    expect(find(flows, "原因診断（チャット調査）").agent).toBe("Anthropic API");
    expect(find(flows, "新規アプリ相談・手作業の修正提案").agent).toBe("Anthropic API");
  });
});

describe("resolveProviderFlowRows", () => {
  // 画面へ渡る値は保存時点のプロバイダーで解決済み。個別設定でない項目はプロバイダーで解き直される
  const resolved = {
    ...settings,
    claudeLocalModel: "sonnet",
    codexModel: "gpt-5.6-terra",
    defaultDispatchAgent: "claude",
    planReviewAgentForClaude: "claude",
    planReviewAgentForCodex: "claude",
    appAiModel: "claude-haiku-4-5",
    appAiModelReasoning: "claude-sonnet-5-5",
    modelPickEngine: "app-ai",
  } as const;
  const steps = ["計画", "実装", "計画レビュー", "PRレビュー", "レビュー修復", "アプリ内AI", "判定"];

  it("Claude・Codexのどちらでも工程の並びを変えない", () => {
    for (const provider of ["claude", "codex"] as const) {
      expect(resolveProviderFlowRows(resolved, provider, NO_AI_PROVIDER_OVERRIDES).map((row) => row.step)).toEqual(steps);
    }
  });

  it("個別設定の無い項目はプロバイダーへ追従する", () => {
    const rows = resolveProviderFlowRows(resolved, "codex", NO_AI_PROVIDER_OVERRIDES);
    const plan = rows.find((row) => row.step === "計画")!;

    expect(plan.entries).toEqual([
      expect.objectContaining({ label: "サブPC", agent: "Codex CLI", model: "GPT-5.6 Terra", binding: "provider" }),
      expect.objectContaining({ label: "GitHub Actions", agent: "Codex Action", model: "GPT-5.6 Terra", binding: "provider" }),
    ]);
    expect(rows.find((row) => row.step === "計画レビュー")!.entries[0]).toEqual(
      expect.objectContaining({ agent: "Codex CLI", model: "GPT-6 Sol", binding: "provider" }),
    );
    const appAi = rows.find((row) => row.step === "アプリ内AI")!.entries;
    expect(appAi[1]).toEqual(expect.objectContaining({ agent: "Codex CLI（ChatGPTサブスク）", binding: "provider" }));
    expect(appAi[2]).toEqual(expect.objectContaining({ agent: "OpenAI API（従量課金）", binding: "provider" }));
  });

  it("個別設定した項目はプロバイダーを切り替えても変わらない", () => {
    const overrides = { ...NO_AI_PROVIDER_OVERRIDES, planReviewAgentForCodex: true, appAiModel: true };
    const rows = resolveProviderFlowRows(resolved, "codex", overrides);

    // 開始元ごとに結果が分かれるので、固定している側と追従している側を別々に出す（#4139）
    const planReview = rows.find((row) => row.step === "計画レビュー")!.entries;
    expect(planReview).toHaveLength(2);
    expect(planReview.find((entry) => entry.label.includes("Codex CLIの計画"))).toEqual(
      expect.objectContaining({ agent: "Claude Code", model: "Opus 5.5", binding: "override" }),
    );
    expect(planReview.find((entry) => entry.label.includes("Claude Codeの計画"))).toEqual(
      expect.objectContaining({ agent: "Codex CLI", binding: "provider" }),
    );
    expect(rows.find((row) => row.step === "アプリ内AI")!.entries[0]).toEqual(
      expect.objectContaining({ agent: "Anthropic API", binding: "override" }),
    );
  });

  it("継承なら計画の作成元に関わらず全体の切替に従い、実効エージェントが1行に揃う（#4139）", () => {
    for (const provider of ["claude", "codex", "claude"] as const) {
      const entries = resolveProviderFlowRows(resolved, provider, NO_AI_PROVIDER_OVERRIDES)
        .find((row) => row.step === "計画レビュー")!.entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(expect.objectContaining({
        agent: provider === "claude" ? "Claude Code" : "Codex CLI",
        binding: "provider",
      }));
    }
  });

  it("PRレビュー・修復は実装したエージェントの側で走り、実装先が分かれれば両方を出す", () => {
    const claude = resolveProviderFlowRows(resolved, "claude", NO_AI_PROVIDER_OVERRIDES);
    expect(claude.find((row) => row.step === "PRレビュー")!.entries).toEqual([
      expect.objectContaining({ label: "GitHub Actions（Claude実装）", agent: "Claude Code", binding: "implementation" }),
    ]);

    const split = resolveProviderFlowRows(resolved, "claude", { ...NO_AI_PROVIDER_OVERRIDES, githubActionsAgent: true });
    expect(resolveProviderFlowRows({ ...resolved, githubActionsAgent: "codex" }, "claude", { ...NO_AI_PROVIDER_OVERRIDES, githubActionsAgent: true })
      .find((row) => row.step === "レビュー修復")!.entries.map((entry) => entry.agent)).toEqual(["Claude Code", "Codex CLI"]);
    expect(split.find((row) => row.step === "PRレビュー")!.entries).toHaveLength(1);
  });

  it("判定はJevならプロバイダーと無関係", () => {
    const rows = resolveProviderFlowRows({ ...resolved, modelPickEngine: "jev" }, "codex", NO_AI_PROVIDER_OVERRIDES);
    expect(rows.find((row) => row.step === "判定")!.entries[0].binding).toBe("independent");
  });
});

describe("readAiProviderOverrides", () => {
  it("inheritと未設定は追従、値が読めるものは個別設定と読む", () => {
    expect(readAiProviderOverrides({
      githubActionsAgent: "inherit",
      defaultDispatchAgent: "codex",
      planReviewAgentForClaude: undefined,
      planReviewAgentForCodex: "claude",
      appAiModel: "inherit",
      appAiModelReasoning: "claude-sonnet-5",
    })).toEqual({
      githubActionsAgent: false,
      defaultDispatchAgent: true,
      planReviewAgentForClaude: false,
      planReviewAgentForCodex: true,
      appAiModel: false,
      appAiModelReasoning: true,
    });
  });
});
