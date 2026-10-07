import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({ db: { appSetting: { findUnique: (...args: unknown[]) => findUnique(...args) } } }));

vi.mock("@/lib/chat/investigation/agent", () => ({ STEP_SCHEMA: {} }));
vi.mock("@/lib/claude/request", () => ({ callClaudeMessages: vi.fn(), getAppAiToken: vi.fn() }));

import { resolveChatExecution } from "@/lib/chat/investigation/model";

function setting(aiExecutionProvider: string, appAiModelReasoning: string) {
  findUnique.mockResolvedValue({ aiExecutionProvider, appAiModelReasoning });
}

describe("resolveChatExecution（#4143）", () => {
  beforeEach(() => {
    findUnique.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  it("Claude主系 + Claude reasoning → API経路", async () => {
    setting("claude", "claude-sonnet-5-5");
    expect(await resolveChatExecution()).toEqual({ mode: "api" });
  });

  it("Claude主系 + GPT reasoning → Codex CLI（OPENAI_API_KEY未設定でも）", async () => {
    setting("claude", "gpt-5.6-terra");
    expect(await resolveChatExecution()).toEqual({ mode: "codex", model: "gpt-5.6-terra" });
  });

  it("Codex主系 + GPT reasoning → Codex CLI", async () => {
    setting("codex", "gpt-6-sol");
    expect(await resolveChatExecution()).toEqual({ mode: "codex", model: "gpt-6-sol" });
  });

  it("Codex主系 + Claude reasoning Override → Claude側の既存経路", async () => {
    setting("codex", "claude-opus-5-5");
    expect(await resolveChatExecution()).toEqual({ mode: "api" });
  });

  it("個別指定が無ければ主系の既定モデルに従う", async () => {
    findUnique.mockResolvedValue({ aiExecutionProvider: "codex", appAiModelReasoning: "inherit" });
    expect(await resolveChatExecution()).toEqual({ mode: "codex", model: "gpt-5.6-terra" });
    findUnique.mockResolvedValue({ aiExecutionProvider: "claude", appAiModelReasoning: "inherit" });
    expect(await resolveChatExecution()).toEqual({ mode: "api" });
  });

  it("設定を変えた次の呼び出しから経路が切り替わる", async () => {
    setting("claude", "claude-sonnet-5-5");
    expect((await resolveChatExecution()).mode).toBe("api");
    setting("claude", "gpt-6-luna");
    expect(await resolveChatExecution()).toEqual({ mode: "codex", model: "gpt-6-luna" });
  });

  it("設定を読めないときは既定（Claude系）でAPI経路", async () => {
    findUnique.mockRejectedValue(new Error("db"));
    expect(await resolveChatExecution()).toEqual({ mode: "api" });
  });
});
