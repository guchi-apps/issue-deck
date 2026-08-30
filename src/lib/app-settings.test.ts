import { describe, expect, it } from "vitest";
import {
  DISPATCH_CONCURRENCY_MAX,
  DISPATCH_CONCURRENCY_MIN,
  parseAutoRetryLimit,
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
