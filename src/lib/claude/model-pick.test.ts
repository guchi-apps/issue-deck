import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildModelPickPrompt,
  buildModelPickQuestions,
  buildModelPickState,
  parseModelPick,
  pickModelByJev,
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
    expect(pickModelByRule(input({ labels: ["40.investigation"] })).model).toBe("opus");
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
    expect(parseModelPick('{"model":"gpt-6-astra","reason":"設計が必要なためです。"}', "codex")).toEqual({
      model: "gpt-6-astra",
      reason: "設計が必要なためです。",
    });
    expect(parseModelPick('{"model":"gpt-6-sol","reason":"調査が要るためです。"}', "codex")).toEqual({
      model: "gpt-6-sol",
      reason: "調査が要るためです。",
    });
    expect(parseModelPick('{"model":"gpt-6-luna","reason":"軽い修正のためです。"}', "codex")?.model).toBe(
      "gpt-6-luna",
    );
  });

  // Codexの欄にClaudeのモデルが紛れると、`-m opus`で起動しようとして落ちる
  it("Claudeの候補・旧世代・autoはCodexでは採らない", () => {
    expect(parseModelPick('{"model":"opus","reason":"x"}', "codex")).toBeNull();
    expect(parseModelPick('{"model":"gpt-5.5","reason":"x"}', "codex")).toBeNull();
    expect(parseModelPick('{"model":"auto","reason":"x"}', "codex")).toBeNull();
    // 逆に、Claudeの欄でCodexのモデルは採らない（従来どおり）
    expect(parseModelPick('{"model":"gpt-6-sol","reason":"x"}', "claude")).toBeNull();
  });

  it("プロンプトはCodex CLIとCodexの候補を案内する", () => {
    const prompt = buildModelPickPrompt(input(), "codex");
    expect(prompt).toContain("Codex CLI");
    expect(prompt).toContain("gpt-6-astra");
    expect(prompt).toContain("gpt-6-sol");
    expect(prompt).toContain("gpt-5.6-terra");
    expect(prompt).toContain("gpt-6-luna");
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
      expect(pickModelByRule(input({ labels: ["52.bug"] }), "codex").model).toBe("gpt-6-sol");
    });

    it("計画が要る・長い・やり取りが多いものはSol", () => {
      expect(pickModelByRule(input({ labels: ["21.plan-required"] }), "codex").model).toBe(
        "gpt-6-sol",
      );
      expect(pickModelByRule(input({ body: "あ".repeat(800) }), "codex").model).toBe("gpt-6-sol");
      expect(pickModelByRule(input({ commentCount: 10 }), "codex").model).toBe("gpt-6-sol");
    });

    it("文書だけの短い更新はLuna", () => {
      expect(pickModelByRule(input({ labels: ["60.documentation"] }), "codex").model).toBe(
        "gpt-6-luna",
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

describe("buildModelPickState / buildModelPickQuestions", () => {
  it("Jevへは文章ではなくJSONで材料を渡す", () => {
    const state = buildModelPickState(input({ labels: ["51.improvement"], planComment: "直します" }));
    expect(state).toMatchObject({
      タイトル: "ボタンの文言を直す",
      ラベル: ["51.improvement"],
      コメント数: 0,
      承認済みの計画: "直します",
    });
  });

  it("計画が無ければその項目を入れない", () => {
    expect(buildModelPickState(input())).not.toHaveProperty("承認済みの計画");
  });

  // 候補の綴りがずれると、返ってきた答えを候補集合で弾いてしまう
  it("選択肢はジョブへ積めるモデル名そのものにする", () => {
    const questions = buildModelPickQuestions();
    expect(questions.model.type).toBe("choice");
    expect(Object.keys((questions.model as { criteria: Record<string, unknown> }).criteria)).toEqual([
      "sonnet",
      "opus",
      "fable",
    ]);
  });

  // 難しさ・調査の要否はモデルの選択に使っておらず、画面にも出さなくなった（#3255）
  it("聞くのはモデルの1問だけにする", () => {
    expect(Object.keys(buildModelPickQuestions())).toEqual(["model"]);
    expect(Object.keys(buildModelPickQuestions("codex"))).toEqual(["model"]);
  });

  // Codexの欄でClaudeの候補を出すと、`-m opus`で起動しようとして落ちる（#3192と同じ理由）
  it("Codexの選択肢はCodexのモデル名にする", () => {
    const questions = buildModelPickQuestions("codex");
    expect(Object.keys((questions.model as { criteria: Record<string, unknown> }).criteria)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-terra",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(JSON.stringify(questions.model)).toContain("Codex CLI");
  });
});

function jevResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("pickModelByJev", () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    vi.unstubAllGlobals();
  });

  it("選んだモデルと確率を返す。理由は空で、確信度は返さない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jevResponse({
          model: "jev-1.13.0",
          answers: {
            model: {
              type: "choice",
              choice: "opus",
              confidence: 0.82,
              probabilities: { opus: 0.82, sonnet: 0.15, fable: 0.03 },
            },
          },
          usage: { input_tokens: 400, output_tokens: 0 },
        }),
      ),
    );

    expect(await pickModelByJev(input())).toEqual({
      model: "opus",
      reason: "",
      source: "jev",
      probabilities: { opus: 0.82, sonnet: 0.15, fable: 0.03 },
    });
  });

  it("確率が欠けていてもモデルさえ読めれば採用する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jevResponse({
          model: "jev-1.13.0",
          answers: { model: { type: "choice", choice: "sonnet", confidence: 0.6 } },
        }),
      ),
    );

    const result = await pickModelByJev(input());
    expect(result?.model).toBe("sonnet");
    expect(result?.probabilities).toBeUndefined();
  });

  // 候補外は構造上返らないはずだが、返ってきたら採らずに呼び出し元へ倒させる
  it("候補に無いモデル・答えの型違い・呼び出しの失敗はnull", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jevResponse({ answers: { model: { type: "choice", choice: "haiku", confidence: 1 } } }),
      ),
    );
    expect(await pickModelByJev(input())).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jevResponse({ answers: { model: { type: "noul", noul: 0.5 } } })),
    );
    expect(await pickModelByJev(input())).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jevResponse({ error: "x" }, 500)));
    expect(await pickModelByJev(input())).toBeNull();
  });

  it("Codexを指定するとCodexのモデルと確率を返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jevResponse({
          model: "jev-1.13.0",
          answers: {
            model: {
              type: "choice",
              choice: "gpt-6-sol",
              confidence: 0.7,
              // 候補に無いラベル（Claude側のモデル）が混じっても捨てる
              probabilities: { "gpt-6-sol": 0.7, "gpt-5.6-terra": 0.3, opus: 0.9 },
            },
          },
        }),
      ),
    );

    const result = await pickModelByJev(input(), "codex");
    expect(result?.model).toBe("gpt-6-sol");
    expect(result?.probabilities).toEqual({ "gpt-6-sol": 0.7, "gpt-5.6-terra": 0.3 });
  });

  // Claudeの欄でCodexのモデルが返ってきても採らない（逆も同じ）
  it("エージェントの候補外は採らない", async () => {
    // 応答の本体は1度しか読めないため、呼び出しごとに作り直す
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jevResponse({
          answers: { model: { type: "choice", choice: "gpt-6-sol", confidence: 1 } },
        }),
      ),
    );
    expect(await pickModelByJev(input())).toBeNull();
    expect(await pickModelByJev(input(), "codex")).not.toBeNull();
  });

  it("APIキーが無ければnull（呼び出し元がアプリ内AIへ倒す）", async () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(await pickModelByJev(input())).toBeNull();
  });
});
