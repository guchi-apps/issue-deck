import { describe, expect, it } from "vitest";
import {
  appAiProvider,
  DISPATCH_CONCURRENCY_MAX,
  DISPATCH_CONCURRENCY_MIN,
  parseAppAiModel,
  parseAutoRetryLimit,
  parseClaudeLocalModel,
  parseClaudeModel,
  parseCodexModel,
  parseDispatchConcurrency,
} from "@/lib/app-settings";

describe("parseAutoRetryLimit", () => {
  it("範囲内の整数はそのまま返す", () => {
    expect(parseAutoRetryLimit(0)).toBe(0);
    expect(parseAutoRetryLimit(3)).toBe(3);
    expect(parseAutoRetryLimit(10)).toBe(10);
  });

  it("範囲外の整数はnullを返す", () => {
    expect(parseAutoRetryLimit(-1)).toBeNull();
    expect(parseAutoRetryLimit(11)).toBeNull();
  });

  it("整数でない値はnullを返す", () => {
    expect(parseAutoRetryLimit(1.5)).toBeNull();
    expect(parseAutoRetryLimit("3")).toBeNull();
    expect(parseAutoRetryLimit(null)).toBeNull();
    expect(parseAutoRetryLimit(undefined)).toBeNull();
  });
});

describe("parseAppAiModel", () => {
  it("許可された値はそのまま返す", () => {
    expect(parseAppAiModel("claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(parseAppAiModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(parseAppAiModel("claude-opus-5")).toBe("claude-opus-5");
    expect(parseAppAiModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(parseAppAiModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(parseAppAiModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  it("許可されていない値はnullを返す", () => {
    expect(parseAppAiModel("auto")).toBeNull();
    expect(parseAppAiModel("gpt-5.5")).toBeNull();
    expect(parseAppAiModel(null)).toBeNull();
  });
});

describe("appAiProvider", () => {
  it("モデルからAPIプロバイダーを判定する", () => {
    expect(appAiProvider("claude-haiku-4-5")).toBe("anthropic");
    expect(appAiProvider("gpt-5.6-terra")).toBe("openai");
  });
});

describe("parseDispatchConcurrency", () => {
  it("範囲内の整数はそのまま返す", () => {
    expect(parseDispatchConcurrency(DISPATCH_CONCURRENCY_MIN)).toBe(DISPATCH_CONCURRENCY_MIN);
    expect(parseDispatchConcurrency(2)).toBe(2);
    expect(parseDispatchConcurrency(DISPATCH_CONCURRENCY_MAX)).toBe(DISPATCH_CONCURRENCY_MAX);
  });

  it("0以下は受け付けない（0にすると起動できないまま滞留するため）", () => {
    expect(parseDispatchConcurrency(0)).toBeNull();
    expect(parseDispatchConcurrency(-1)).toBeNull();
  });

  it("上限を超える値・整数でない値はnullを返す", () => {
    expect(parseDispatchConcurrency(DISPATCH_CONCURRENCY_MAX + 1)).toBeNull();
    expect(parseDispatchConcurrency(1.5)).toBeNull();
    expect(parseDispatchConcurrency("2")).toBeNull();
    expect(parseDispatchConcurrency(null)).toBeNull();
    expect(parseDispatchConcurrency(undefined)).toBeNull();
  });
});

describe("parseClaudeModel", () => {
  it("許可された値はそのまま返す", () => {
    expect(parseClaudeModel("auto")).toBe("auto");
    expect(parseClaudeModel("opus")).toBe("opus");
    expect(parseClaudeModel("sonnet")).toBe("sonnet");
    expect(parseClaudeModel("haiku")).toBe("haiku");
  });

  it("許可されていない値はnullを返す", () => {
    expect(parseClaudeModel("claude-opus-4-1-20250805")).toBeNull();
    expect(parseClaudeModel("")).toBeNull();
    expect(parseClaudeModel(1)).toBeNull();
    expect(parseClaudeModel(null)).toBeNull();
    expect(parseClaudeModel(undefined)).toBeNull();
  });
});

// haikuはauto mode（--permission-mode auto）で動作しないため（#2756・
// https://github.com/anthropics/claude-code/issues/43235）、ローカルセッション用の候補には含めない。
describe("parseClaudeLocalModel", () => {
  it("haiku以外の許可された値はそのまま返す", () => {
    expect(parseClaudeLocalModel("auto")).toBe("auto");
    expect(parseClaudeLocalModel("opus")).toBe("opus");
    expect(parseClaudeLocalModel("sonnet")).toBe("sonnet");
    expect(parseClaudeLocalModel("fable")).toBe("fable");
  });

  it("haikuはnullを返す（auto modeで動作しないため）", () => {
    expect(parseClaudeLocalModel("haiku")).toBeNull();
  });

  it("許可されていない値はnullを返す", () => {
    expect(parseClaudeLocalModel("claude-opus-4-1-20250805")).toBeNull();
    expect(parseClaudeLocalModel("")).toBeNull();
    expect(parseClaudeLocalModel(1)).toBeNull();
    expect(parseClaudeLocalModel(null)).toBeNull();
    expect(parseClaudeLocalModel(undefined)).toBeNull();
  });
});

describe("parseCodexModel", () => {
  it("許可された値はそのまま返す", () => {
    expect(parseCodexModel("auto")).toBe("auto");
    expect(parseCodexModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(parseCodexModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(parseCodexModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(parseCodexModel("gpt-5.5")).toBe("gpt-5.5");
    expect(parseCodexModel("gpt-5.4")).toBe("gpt-5.4");
  });

  it("許可されていない値はnullを返す", () => {
    expect(parseCodexModel("gpt-5-codex")).toBeNull();
    expect(parseCodexModel(5)).toBeNull();
  });
});
