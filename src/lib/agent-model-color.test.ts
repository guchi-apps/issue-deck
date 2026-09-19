import { describe, expect, it } from "vitest";

import {
  AGENT_MODEL_TIER_COLORS,
  agentModelColor,
  modelWeightTier,
  pickPrimaryModel,
} from "@/lib/agent-model-color";

describe("modelWeightTier", () => {
  it("出力単価でClaude・Codexを同じ物差しの4段に分ける", () => {
    expect(modelWeightTier("claude-fable-5-1")).toBe(0);
    expect(modelWeightTier("claude-opus-5")).toBe(1);
    expect(modelWeightTier("claude-sonnet-5")).toBe(2);
    expect(modelWeightTier("claude-haiku-4-5-20251001")).toBe(3);
    expect(modelWeightTier("gpt-5.6-sol")).toBe(1);
    expect(modelWeightTier("gpt-5.5")).toBe(1);
    expect(modelWeightTier("gpt-5.6-terra")).toBe(2);
    expect(modelWeightTier("gpt-5.4")).toBe(2);
    expect(modelWeightTier("gpt-5.6-luna")).toBe(3);
  });

  it("起動時に指定するエイリアスも段を引ける", () => {
    expect(modelWeightTier("fable")).toBe(0);
    expect(modelWeightTier("opus")).toBe(1);
    expect(modelWeightTier("sonnet")).toBe(2);
    expect(modelWeightTier("haiku")).toBe(3);
  });

  it("CLI任せ・単価表に無いモデル・未指定はnull", () => {
    expect(modelWeightTier("auto")).toBeNull();
    expect(modelWeightTier("some-unknown-model")).toBeNull();
    expect(modelWeightTier(null)).toBeNull();
    expect(modelWeightTier("")).toBeNull();
  });
});

describe("agentModelColor", () => {
  it("エージェントの系統から段の色を引く", () => {
    expect(agentModelColor("claude", "claude-opus-5")).toBe(AGENT_MODEL_TIER_COLORS.claude[1]);
    expect(agentModelColor("codex", "gpt-5.6-luna")).toBe(AGENT_MODEL_TIER_COLORS.codex[3]);
  });

  it("段が決まらなければnull（中抜きで出す）", () => {
    expect(agentModelColor("codex", null)).toBeNull();
    expect(agentModelColor("claude", "auto")).toBeNull();
  });
});

describe("pickPrimaryModel", () => {
  it("併用している軽いモデルではなく、いちばん重いモデルを採る", () => {
    expect(pickPrimaryModel(["claude-haiku-4-5-20251001", "claude-opus-5"])).toBe("claude-opus-5");
  });

  it("段が決まるモデルが無ければnull", () => {
    expect(pickPrimaryModel([])).toBeNull();
    expect(pickPrimaryModel(["some-unknown-model"])).toBeNull();
  });
});
