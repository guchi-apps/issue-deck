import { describe, expect, it } from "vitest";

import {
  buildModelPickPrompt,
  parseModelPick,
  pickModelByRule,
  type ModelPickInput,
} from "@/lib/claude/model-pick";

function input(overrides: Partial<ModelPickInput> = {}): ModelPickInput {
  return {
    title: "ボタンの文言を直す",
    body: "「保存」を「更新」にする。",
    labels: ["51.improvement"],
    commentCount: 0,
    ...overrides,
  };
}

describe("parseModelPick", () => {
  it("JSONからモデルと理由を取り出す", () => {
    expect(parseModelPick('{"model":"opus","reason":"調査が要るためです。"}')).toEqual({
      model: "opus",
      reason: "調査が要るためです。",
    });
  });

  it("コードフェンスで囲まれていても読む", () => {
    expect(parseModelPick('```json\n{"model":"opus","reason":"調査が要るためです。"}\n```')?.model).toBe(
      "opus",
    );
  });

  // 候補に無いモデルを通すと、APIが400で断るか、知らないモデルで起動しようとする
  it("候補に無いモデルは採らない", () => {
    expect(parseModelPick('{"model":"gpt-5.6-sol","reason":"速いためです。"}')).toBeNull();
    expect(parseModelPick('{"model":"auto","reason":"任せます。"}')).toBeNull();
  });

  // haikuはauto mode（--permission-mode auto）で動作しないため候補から外している
  // （#2756・https://github.com/anthropics/claude-code/issues/43235）
  it("haikuは採らない", () => {
    expect(parseModelPick('{"model":"haiku","reason":"短いためです。"}')).toBeNull();
  });

  it("JSONとして読めなければnull", () => {
    expect(parseModelPick("Opusがよいと思います")).toBeNull();
  });

  // 理由が無いだけで捨てると、選べたのにルールへ倒れることになる
  it("理由が無くてもモデルが読めれば採る", () => {
    expect(parseModelPick('{"model":"sonnet"}')).toEqual({ model: "sonnet", reason: "" });
  });
});

describe("pickModelByRule", () => {
  it("不具合のIssueは調査が要るものとして扱う", () => {
    expect(pickModelByRule(input({ labels: ["30.bug"] })).model).toBe("opus");
    expect(pickModelByRule(input({ labels: ["40.unexpected"] })).model).toBe("opus");
  });

  // ラベルの番号はリポジトリごとにずれるので、番号ではなく名前で判定する
  it("ラベルの番号が違っても同じ判定になる", () => {
    expect(pickModelByRule(input({ labels: ["31.bug"] })).model).toBe("opus");
  });

  it("計画が要る・やり取りが長いものは決めることが多いとみなす", () => {
    expect(pickModelByRule(input({ labels: ["21.plan-required"] })).model).toBe("opus");
    expect(pickModelByRule(input({ commentCount: 12 })).model).toBe("opus");
  });

  // 以前はHaikuへ倒していたが、auto mode（--permission-mode auto）で動作しないため
  // 候補から外し、Sonnetへ倒すようにした（#2756・https://github.com/anthropics/claude-code/issues/43235）
  it("短く書かれた改善もSonnet", () => {
    expect(pickModelByRule(input()).model).toBe("sonnet");
  });

  it("判断が付かなければSonnet", () => {
    expect(pickModelByRule(input({ labels: [], body: "a".repeat(400) })).model).toBe("sonnet");
  });

  // AIが落ちている間ずっと一番高いモデルで走らないよう、ここでFableは選ばない
  it("ルールではFableを選ばない", () => {
    const models = [
      pickModelByRule(input({ labels: ["30.bug"], body: "a".repeat(2000) })).model,
      pickModelByRule(input({ labels: ["21.plan-required"] })).model,
      pickModelByRule(input({ labels: [] })).model,
    ];
    expect(models).not.toContain("fable");
  });

  it("理由を必ず添える（画面がそのまま出す）", () => {
    expect(pickModelByRule(input()).reason.length).toBeGreaterThan(0);
  });
});

describe("buildModelPickPrompt", () => {
  it("タイトル・ラベル・本文を載せる", () => {
    const prompt = buildModelPickPrompt(input({ labels: ["51.improvement", "11.local"] }));
    expect(prompt).toContain("ボタンの文言を直す");
    expect(prompt).toContain("51.improvement, 11.local");
    expect(prompt).toContain("「保存」を「更新」にする。");
  });

  it("承認済みの計画があれば材料に含める", () => {
    const prompt = buildModelPickPrompt(input({ planComment: "## 要約\n直します" }));
    expect(prompt).toContain("承認済みの計画");
    expect(prompt).toContain("直します");
  });

  it("計画が無ければその見出しごと出さない", () => {
    expect(buildModelPickPrompt(input())).not.toContain("承認済みの計画");
  });

  // 本文が無いIssueでも判定は走る（タイトルとラベルだけで選ぶ）
  it("本文が空でも組み立てられる", () => {
    expect(buildModelPickPrompt(input({ body: "" }))).toContain("（本文なし）");
  });
});

// #3192。Codexの「おまかせ」。判定を行うのはどちらもアプリ内AIで、変わるのは候補・プロンプト・ルール
describe("Codexの候補（#3192）", () => {
  it("Codexの応答からはCodexの候補だけを採る", () => {
    expect(parseModelPick('{"model":"gpt-5.6-sol","reason":"調査が要るためです。"}', "codex")).toEqual({
      model: "gpt-5.6-sol",
      reason: "調査が要るためです。",
    });
    expect(parseModelPick('{"model":"gpt-5.6-luna","reason":"軽い修正のためです。"}', "codex")?.model).toBe(
      "gpt-5.6-luna",
    );
  });

  // Codexの欄にClaudeのモデルが紛れると、`-m opus`で起動しようとして落ちる
  it("Claudeの候補・旧世代・autoはCodexでは採らない", () => {
    expect(parseModelPick('{"model":"opus","reason":"x"}', "codex")).toBeNull();
    expect(parseModelPick('{"model":"gpt-5.5","reason":"x"}', "codex")).toBeNull();
    expect(parseModelPick('{"model":"auto","reason":"x"}', "codex")).toBeNull();
    // 逆に、Claudeの欄でCodexのモデルは採らない（従来どおり）
    expect(parseModelPick('{"model":"gpt-5.6-sol","reason":"x"}', "claude")).toBeNull();
  });

  it("プロンプトはCodex CLIとCodexの候補を案内する", () => {
    const prompt = buildModelPickPrompt(input(), "codex");
    expect(prompt).toContain("Codex CLI");
    expect(prompt).toContain("gpt-5.6-sol");
    expect(prompt).toContain("gpt-5.6-terra");
    expect(prompt).toContain("gpt-5.6-luna");
    expect(prompt).not.toContain("`opus`");
    expect(prompt).toContain("ボタンの文言を直す");
  });

  it("agentを省略したプロンプトはClaude Codeのまま", () => {
    const prompt = buildModelPickPrompt(input());
    expect(prompt).toContain("Claude Code");
    expect(prompt).toContain("`fable`");
    expect(prompt).not.toContain("gpt-5.6");
  });

  describe("ルール", () => {
    it("不具合はSol", () => {
      expect(pickModelByRule(input({ labels: ["52.bug"] }), "codex").model).toBe("gpt-5.6-sol");
    });

    it("計画が要る・長い・やり取りが多いものはSol", () => {
      expect(pickModelByRule(input({ labels: ["21.plan-required"] }), "codex").model).toBe(
        "gpt-5.6-sol",
      );
      expect(pickModelByRule(input({ body: "あ".repeat(800) }), "codex").model).toBe("gpt-5.6-sol");
      expect(pickModelByRule(input({ commentCount: 10 }), "codex").model).toBe("gpt-5.6-sol");
    });

    it("文書だけの短い更新はLuna", () => {
      expect(pickModelByRule(input({ labels: ["60.documentation"] }), "codex").model).toBe(
        "gpt-5.6-luna",
      );
    });

    it("迷ったらTerra。理由は必ず添える", () => {
      const picked = pickModelByRule(input(), "codex");
      expect(picked.model).toBe("gpt-5.6-terra");
      expect(picked.reason.length).toBeGreaterThan(0);
    });

    it("agentを省略した判定は従来どおりClaudeの候補", () => {
      expect(pickModelByRule(input({ labels: ["52.bug"] })).model).toBe("opus");
    });
  });
});
