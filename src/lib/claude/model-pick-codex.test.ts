import { beforeEach, describe, expect, it, vi } from "vitest";

import { pickModelByRule, pickModelForIssue, type ModelPickInput } from "@/lib/claude/model-pick";
import { CODEX_APP_AI_TOKEN } from "@/lib/claude/app-ai-codex";
import { getAppAiToken } from "@/lib/claude/request";

const { findUniqueSetting } = vi.hoisted(() => ({ findUniqueSetting: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { appSetting: { findUnique: findUniqueSetting } } }));

const input: ModelPickInput = { title: "文言を直す", body: "", labels: [], commentCount: 0 };

// GPT系を選んだ設定で「おまかせ」を押しても、Codexが未対応と返した失敗でダイアログを塞がず、
// 設定画面の説明どおりルール判定で継続する（#5074）
describe("GPT系設定でのモデル自動選択", () => {
  beforeEach(() => {
    findUniqueSetting.mockResolvedValue({ appAiModel: "gpt-6-luna", aiExecutionProvider: "codex" });
  });

  it("Codex経路が未対応で失敗しても、投げずにルール判定へ倒す", async () => {
    const token = await getAppAiToken("model_pick");
    expect(token).toBe(CODEX_APP_AI_TOKEN);
    const result = await pickModelForIssue(token as string, input);
    expect(result).toEqual({ ...pickModelByRule(input, "claude"), source: "rule" });
  });
});
