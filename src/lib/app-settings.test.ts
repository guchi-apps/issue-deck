import { describe, expect, it } from "vitest";
import {
  describeBulkReserveModel,
  encodeBulkReserveModel,
  parseBulkReserveModelChoice,
  appAiProvider,
  DISPATCH_CONCURRENCY_MAX,
  DISPATCH_CONCURRENCY_MIN,
  parseAppAiModel,
  parseAutoRetryLimit,
  parseClaudeLocalModel,
  parseClaudeLocalModelSetting,
  parseClaudeModel,
  parseCodexLocalModel,
  parseCodexModel,
  parseCodexModelSetting,
  parseDispatchConcurrency,
  resolveCodexInitialModel,
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
    expect(parseAppAiModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(parseAppAiModel("gpt-6-sol")).toBe("gpt-6-sol");
    expect(parseAppAiModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(parseAppAiModel("gpt-6-luna")).toBe("gpt-6-luna");
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
// autoは「どのモデルで動くか分からないまま起動できる方式」自体が不要というIssueの要求により
// 候補から外した（#2776）。
describe("parseClaudeLocalModel", () => {
  it("haiku・auto以外の許可された値はそのまま返す", () => {
    expect(parseClaudeLocalModel("opus")).toBe("opus");
    expect(parseClaudeLocalModel("sonnet")).toBe("sonnet");
    expect(parseClaudeLocalModel("fable")).toBe("fable");
  });

  it("haikuはnullを返す（auto modeで動作しないため）", () => {
    expect(parseClaudeLocalModel("haiku")).toBeNull();
  });

  it("autoはnullを返す（#2776）", () => {
    expect(parseClaudeLocalModel("auto")).toBeNull();
  });

  // ジョブ・APIの`model`は具体的なモデル名だけ。「おまかせ」は判定してから積む（#3106）
  it("pickはnullを返す（設定専用の値のため）", () => {
    expect(parseClaudeLocalModel("pick")).toBeNull();
  });

  it("許可されていない値はnullを返す", () => {
    expect(parseClaudeLocalModel("claude-opus-4-1-20250805")).toBeNull();
    expect(parseClaudeLocalModel("")).toBeNull();
    expect(parseClaudeLocalModel(1)).toBeNull();
    expect(parseClaudeLocalModel(null)).toBeNull();
    expect(parseClaudeLocalModel(undefined)).toBeNull();
  });
});

// 設定`claudeLocalModel`の検証。ジョブ・API用の`parseClaudeLocalModel`に「おまかせ」を足した形（#3106）
describe("parseClaudeLocalModelSetting", () => {
  it("おまかせ（pick）と、fable・opus・sonnetを通す", () => {
    expect(parseClaudeLocalModelSetting("pick")).toBe("pick");
    expect(parseClaudeLocalModelSetting("fable")).toBe("fable");
    expect(parseClaudeLocalModelSetting("opus")).toBe("opus");
    expect(parseClaudeLocalModelSetting("sonnet")).toBe("sonnet");
  });

  it("haiku・autoと不正な値はnullを返す", () => {
    expect(parseClaudeLocalModelSetting("haiku")).toBeNull();
    expect(parseClaudeLocalModelSetting("auto")).toBeNull();
    expect(parseClaudeLocalModelSetting("")).toBeNull();
    expect(parseClaudeLocalModelSetting(undefined)).toBeNull();
  });
});

describe("parseCodexModel", () => {
  it("許可された値はそのまま返す", () => {
    expect(parseCodexModel("auto")).toBe("auto");
    expect(parseCodexModel("gpt-6-astra")).toBe("gpt-6-astra");
    expect(parseCodexModel("gpt-6-sol")).toBe("gpt-6-sol");
    expect(parseCodexModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(parseCodexModel("gpt-6-luna")).toBe("gpt-6-luna");
    expect(parseCodexModel("gpt-5.5")).toBe("gpt-5.5");
    expect(parseCodexModel("gpt-5.4")).toBe("gpt-5.4");
  });

  it("許可されていない値はnullを返す", () => {
    expect(parseCodexModel("gpt-5-codex")).toBeNull();
    expect(parseCodexModel(5)).toBeNull();
  });
});

// #3192。ダイアログ・ジョブ・APIの`model`（Codex）。旧世代・`auto`・おまかせは通さない
describe("parseCodexLocalModel", () => {
  it("Astra・Sol・Terra・Lunaを通す", () => {
    expect(parseCodexLocalModel("gpt-6-astra")).toBe("gpt-6-astra");
    expect(parseCodexLocalModel("gpt-6-sol")).toBe("gpt-6-sol");
    expect(parseCodexLocalModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(parseCodexLocalModel("gpt-6-luna")).toBe("gpt-6-luna");
  });

  it("旧世代・auto・pick・Claudeのモデル・不正な値はnull", () => {
    for (const value of ["gpt-5.5", "gpt-5.4", "auto", "pick", "opus", "", undefined, null, 1]) {
      expect(parseCodexLocalModel(value)).toBeNull();
    }
  });
});

// 設定`codexModel`の検証。`parseCodexModel`に「おまかせ」を足した形（`parseClaudeLocalModelSetting`のCodex版）
describe("parseCodexModelSetting", () => {
  it("おまかせ（pick）と既存の候補を通す", () => {
    expect(parseCodexModelSetting("pick")).toBe("pick");
    expect(parseCodexModelSetting("auto")).toBe("auto");
    expect(parseCodexModelSetting("gpt-5.5")).toBe("gpt-5.5");
  });

  it("不正な値はnull", () => {
    expect(parseCodexModelSetting("opus")).toBeNull();
    expect(parseCodexModelSetting(undefined)).toBeNull();
  });

  // 払い出し（claim）は`parseCodexModel`で読むので、`pick`は既定（Terra）へ倒れる
  it("払い出しが使うparseCodexModelはpickを通さない", () => {
    expect(parseCodexModel("pick")).toBeNull();
  });
});

describe("resolveCodexInitialModel", () => {
  it("おまかせと、選べる4つはそのまま", () => {
    expect(resolveCodexInitialModel("pick")).toBe("pick");
    expect(resolveCodexInitialModel("gpt-6-astra")).toBe("gpt-6-astra");
    expect(resolveCodexInitialModel("gpt-6-sol")).toBe("gpt-6-sol");
    expect(resolveCodexInitialModel("gpt-6-luna")).toBe("gpt-6-luna");
  });

  it("旧世代・autoは候補に無いのでTerra", () => {
    expect(resolveCodexInitialModel("auto")).toBe("gpt-5.6-terra");
    expect(resolveCodexInitialModel("gpt-5.5")).toBe("gpt-5.6-terra");
    expect(resolveCodexInitialModel("gpt-5.4")).toBe("gpt-5.6-terra");
  });
});

describe("一括予約のモデル選択（#3438）", () => {
  it("<agent>:<model>を往復でき、空文字は設定に従う", () => {
    expect(parseBulkReserveModelChoice("")).toBeNull();
    expect(parseBulkReserveModelChoice("claude:opus")).toEqual({ agent: "claude", model: "opus" });
    const codex = parseBulkReserveModelChoice("codex:gpt-6-sol");
    expect(codex).toEqual({ agent: "codex", model: "gpt-6-sol" });
    expect(encodeBulkReserveModel(codex ?? null)).toBe("codex:gpt-6-sol");
    expect(encodeBulkReserveModel(null)).toBe("");
  });

  it("候補にない値・agentとモデルの取り違えは不正として扱う", () => {
    for (const value of ["opus", "claude:auto", "codex:opus", "codex:auto", "gemini:x", undefined, 1]) {
      expect(parseBulkReserveModelChoice(value)).toBeUndefined();
    }
  });

  it("表示名にエージェントを添える", () => {
    expect(describeBulkReserveModel("")).toBe("設定に従う");
    expect(describeBulkReserveModel("codex:gpt-6-luna")).toBe("Codex ・ GPT-6 Luna");
  });
});
