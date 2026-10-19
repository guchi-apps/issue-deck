import { describe, expect, it } from "vitest";

import { buildModelPickRecord, parseModelPickRecord } from "@/lib/claude/model-pick-record";

describe("buildModelPickRecord（#4853）", () => {
  it("判定が出ていれば、その経路・モデル・Jevの確率を残す", () => {
    expect(
      buildModelPickRecord({
        result: { model: "opus", reason: "", source: "jev", probabilities: { opus: 0.7, sonnet: 0.3 } },
        pickedModel: "opus",
        isAutoPick: true,
        effectiveModel: "opus",
      }),
    ).toEqual({ source: "jev", model: "opus", probabilities: { opus: 0.7, sonnet: 0.3 } });
  });

  it("判定の後に別のチップへ切り替えても、判定が出したモデルを残す（積むモデルと食い違う）", () => {
    expect(
      buildModelPickRecord({
        result: { model: "opus", reason: "調査から", source: "ai" },
        pickedModel: "opus",
        isAutoPick: false,
        effectiveModel: "sonnet",
      }),
    ).toEqual({ source: "ai", model: "opus", probabilities: null });
  });

  it("ルールへ倒れた判定はruleとして残し、確率は持たない", () => {
    expect(
      buildModelPickRecord({
        result: { model: "sonnet", reason: "", source: "rule", probabilities: { sonnet: 1 } },
        pickedModel: "sonnet",
        isAutoPick: true,
        effectiveModel: "sonnet",
      }),
    ).toEqual({ source: "rule", model: "sonnet", probabilities: null });
  });

  it("判定を走らせずにモデルを選んだ起動はmanual", () => {
    expect(
      buildModelPickRecord({ result: null, pickedModel: null, isAutoPick: false, effectiveModel: "fable" }),
    ).toEqual({ source: "manual", model: null, probabilities: null });
  });

  it("積むモデルが無い起動は記録しない", () => {
    expect(
      buildModelPickRecord({ result: null, pickedModel: null, isAutoPick: false, effectiveModel: null }),
    ).toBeNull();
  });
});

describe("parseModelPickRecord（#4853）", () => {
  it("Jevの記録は候補のキーで0〜1の確率だけを残す", () => {
    expect(
      parseModelPickRecord(
        {
          source: "jev",
          model: "opus",
          probabilities: { opus: 0.6, sonnet: 0.4, haiku2: 0.1, fable: 1.5, auto: "x" },
        },
        "claude",
      ),
    ).toEqual({ source: "jev", model: "opus", probabilities: { opus: 0.6, sonnet: 0.4 } });
  });

  it("Jev以外の経路では確率を捨てる", () => {
    expect(
      parseModelPickRecord({ source: "ai", model: "fable", probabilities: { fable: 1 } }, "claude"),
    ).toEqual({ source: "ai", model: "fable", probabilities: null });
  });

  it("manualは判定のモデルを持たない", () => {
    expect(parseModelPickRecord({ source: "manual", model: "opus" }, "claude")).toEqual({
      source: "manual",
      model: null,
      probabilities: null,
    });
  });

  it("エージェントの候補に無いモデル・知らない経路は記録しない", () => {
    expect(parseModelPickRecord({ source: "ai", model: "gpt-6-sol" }, "claude")).toBeNull();
    expect(parseModelPickRecord({ source: "guess", model: "opus" }, "claude")).toBeNull();
    expect(parseModelPickRecord(null, "claude")).toBeNull();
    expect(parseModelPickRecord({ source: "ai", model: "gpt-6-sol" }, "codex")).toEqual({
      source: "ai",
      model: "gpt-6-sol",
      probabilities: null,
    });
  });
});
