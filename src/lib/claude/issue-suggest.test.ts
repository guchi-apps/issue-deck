import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIssueSuggestPrompt,
  buildLabelSuggestQuestions,
  generateIssueSuggestion,
  JEV_LABEL_THRESHOLD,
  JEV_NO_PRIORITY,
  matchSuggestedLabels,
  readLabelSuggestAnswers,
  suggestLabelsByJev,
} from "@/lib/claude/issue-suggest";

describe("buildIssueSuggestPrompt", () => {
  it("本文とラベル一覧（名前・説明）を含むプロンプトを組み立てる", () => {
    const prompt = buildIssueSuggestPrompt({
      body: "特定条件でログインに失敗する",
      availableLabels: [
        { name: "30.bug", description: "不具合" },
        { name: "51.improvement", description: null },
      ],
    });

    expect(prompt).toContain("特定条件でログインに失敗する");
    expect(prompt).toContain("- 30.bug: 不具合");
    expect(prompt).toContain("- 51.improvement");
  });

  it("作業の依頼か質問かを判定させる指示を含む（#1890）", () => {
    const prompt = buildIssueSuggestPrompt({ body: "本文", availableLabels: [] });

    expect(prompt).toContain('"kind"');
    expect(prompt).toContain('"question"');
    expect(prompt).toContain("迷ったら");
  });

  it("ラベルが無い場合は「利用可能なラベルなし」と表示する", () => {
    const prompt = buildIssueSuggestPrompt({ body: "本文", availableLabels: [] });

    expect(prompt).toContain("(利用可能なラベルなし)");
  });

  it("本文が長大な場合は切り詰める", () => {
    const longBody = "あ".repeat(5000);
    const prompt = buildIssueSuggestPrompt({ body: longBody, availableLabels: [] });

    expect(prompt).toContain("...(省略)");
    expect(prompt.length).toBeLessThan(longBody.length + 1000);
  });

  it("30〜89番台（71番台を除く）以外は候補から除外する（#1662）", () => {
    const prompt = buildIssueSuggestPrompt({
      body: "本文",
      availableLabels: [
        { name: "00.check-user", description: "要確認" },
        { name: "01.check-plan", description: "計画の承認待ち" },
        { name: "02.wip", description: "作業中" },
        { name: "11.local", description: "ローカルで対応中" },
        { name: "21.plan-required", description: "計画が必要" },
        { name: "71.manual-step", description: "ユーザー自身の手作業が必要" },
        { name: "91.Close: duplicate", description: "重複のためクローズ" },
        { name: "30.bug", description: "不具合" },
        { name: "80.Priority: High", description: "緊急 高" },
      ],
    });

    expect(prompt).not.toContain("00.check-user");
    expect(prompt).not.toContain("01.check-plan");
    expect(prompt).not.toContain("02.wip");
    expect(prompt).not.toContain("11.local");
    expect(prompt).not.toContain("21.plan-required");
    expect(prompt).not.toContain("71.manual-step");
    expect(prompt).not.toContain("91.Close: duplicate");
    expect(prompt).toContain("- 30.bug: 不具合");
    expect(prompt).toContain("- 80.Priority: High: 緊急 高");
  });

  it("番号プレフィックスを持たないラベルも候補から除外する（ラベル体系未配布のリポジトリ）", () => {
    const prompt = buildIssueSuggestPrompt({
      body: "本文",
      availableLabels: [
        { name: "bug", description: "不具合" },
        { name: "enhancement", description: null },
      ],
    });

    expect(prompt).toContain("(利用可能なラベルなし)");
  });

  it("対象範囲のラベルが1つも無い場合は「利用可能なラベルなし」と表示する", () => {
    const prompt = buildIssueSuggestPrompt({
      body: "本文",
      availableLabels: [
        { name: "00.check-user", description: "要確認" },
        { name: "71.manual-step", description: "ユーザー自身の手作業が必要" },
      ],
    });

    expect(prompt).toContain("(利用可能なラベルなし)");
  });
});

describe("generateIssueSuggestion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockClaudeResponse(payload: unknown) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  it("対象範囲のラベルだけを返す（Claudeが範囲外を返しても落とす。#1662）", async () => {
    mockClaudeResponse({
      title: "ログインに失敗する",
      labels: ["30.bug", "71.manual-step", "11.local", "91.Close: duplicate", "21.plan-required"],
    });

    const result = await generateIssueSuggestion("dummy-token", {
      body: "本文",
      availableLabels: [
        { name: "30.bug", description: "不具合" },
        { name: "71.manual-step", description: "ユーザー自身の手作業が必要" },
        { name: "11.local", description: "ローカルで対応中" },
        { name: "91.Close: duplicate", description: "重複のためクローズ" },
        { name: "21.plan-required", description: "計画が必要" },
      ],
    });

    expect(result).toEqual({ kind: "issue", title: "ログインに失敗する", labels: ["30.bug"] });
  });

  it("リポジトリに存在しないラベル名は落とす", async () => {
    mockClaudeResponse({ title: "タイトル", labels: ["30.bug", "40.investigation"] });

    const result = await generateIssueSuggestion("dummy-token", {
      body: "本文",
      availableLabels: [{ name: "30.bug", description: "不具合" }],
    });

    expect(result.labels).toEqual(["30.bug"]);
  });

  it("種別が質問と返れば question として扱う（#1890）", async () => {
    mockClaudeResponse({ kind: "question", title: "タイトル", labels: [] });

    const result = await generateIssueSuggestion("dummy-token", {
      body: "イシューと質問の違いはなんですか？",
      availableLabels: [],
    });

    expect(result.kind).toBe("question");
  });

  it("種別が欠けていても issue として扱い、タイトル・ラベルは返す（#1890）", async () => {
    mockClaudeResponse({ title: "タイトル", labels: ["30.bug"] });

    const result = await generateIssueSuggestion("dummy-token", {
      body: "本文",
      availableLabels: [{ name: "30.bug", description: "不具合" }],
    });

    expect(result).toEqual({ kind: "issue", title: "タイトル", labels: ["30.bug"] });
  });

  it("APIが返した機械可読な原因を失敗メッセージに含める", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      generateIssueSuggestion("dummy-token", { body: "本文", availableLabels: [] }),
    ).rejects.toThrow("OpenAI APIの利用枠が不足しています。請求設定を確認してください (429: insufficient_quota)");
  });
});

/**
 * #1710。プロンプトでは`- 30.bug: 不具合`の形で候補を渡しているため、モデルが記号や説明を
 * 付けたまま返すことがある。完全一致だけを見ていると、その場合にラベルが1つも付かない。
 */
describe("matchSuggestedLabels", () => {
  const availableLabels = [
    { name: "30.bug", description: "不具合" },
    { name: "51.improvement", description: "機能の改善" },
    { name: "11.local", description: "ローカルで対応中" },
  ];

  it("そのままのラベル名を突き合わせる", () => {
    expect(matchSuggestedLabels(["30.bug"], availableLabels)).toEqual(["30.bug"]);
  });

  it("前後の空白・箇条書きの記号・付いてきた説明を落として突き合わせる", () => {
    expect(
      matchSuggestedLabels(
        [" 30.bug ", "- 51.improvement", "30.bug: 不具合", "・51.improvement：機能の改善"],
        availableLabels,
      ),
    ).toEqual(["30.bug", "51.improvement"]);
  });

  it("自動付与の対象外のラベルは、名前が一致しても採らない", () => {
    expect(matchSuggestedLabels(["11.local"], availableLabels)).toEqual([]);
  });

  it("候補に無いラベル名と文字列以外は採らない", () => {
    expect(matchSuggestedLabels(["99.unknown", 30, null], availableLabels)).toEqual([]);
  });
});

describe("ラベルを含めないプロンプトと応答（Jevがラベルを判定するとき。#3245）", () => {
  const availableLabels = [{ name: "30.bug", description: "不具合" }];

  it("プロンプトからラベルの節と候補一覧を外し、タイトルと種別だけを聞く", () => {
    const prompt = buildIssueSuggestPrompt(
      { body: "特定条件でログインに失敗する", availableLabels },
      { includeLabels: false },
    );

    expect(prompt).toContain("特定条件でログインに失敗する");
    expect(prompt).toContain('"kind"');
    expect(prompt).not.toContain('"labels"');
    expect(prompt).not.toContain("利用可能なラベル一覧");
    expect(prompt).not.toContain("30.bug");
  });

  it("既定ではラベルの節を含む（従来どおり）", () => {
    const prompt = buildIssueSuggestPrompt({ body: "本文", availableLabels });

    expect(prompt).toContain('"labels"');
    expect(prompt).toContain("- 30.bug: 不具合");
  });

  it("`labels`の無い応答でも、タイトルと種別を返しラベルは空にする", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ kind: "issue", title: "タイトル" }) }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await generateIssueSuggestion(
      "dummy-token",
      { body: "本文", availableLabels },
      { includeLabels: false },
    );

    expect(result).toEqual({ kind: "issue", title: "タイトル", labels: [] });
    vi.restoreAllMocks();
  });
});

describe("buildLabelSuggestQuestions（#3245）", () => {
  const availableLabels = [
    { name: "30.bug", description: "再現可能な不具合" },
    { name: "50.feature", description: null },
    { name: "80.Priority: High", description: "優先的に対応する" },
    { name: "89.Priority: Low", description: null },
    { name: "11.local", description: "ローカルで対応中" },
    { name: "71.manual-step", description: "手作業" },
    { name: "enhancement", description: "GitHub既定" },
  ];

  it("優先度以外は1ラベルにつき1つのnoul、優先度は「付けない」を含む1つのchoiceにする", () => {
    const built = buildLabelSuggestQuestions(availableLabels)!;

    expect([...built.noulKeyToLabel.entries()]).toEqual([
      ["label_0", "30.bug"],
      ["label_1", "50.feature"],
    ]);
    expect(built.questions.label_0).toMatchObject({ type: "noul" });
    expect((built.questions.label_0 as { instructions: string }).instructions).toContain(
      "再現可能な不具合",
    );
    expect(built.questions.priority).toMatchObject({
      type: "choice",
      criteria: {
        "80.Priority: High": "優先的に対応する",
        "89.Priority: Low": null,
        [JEV_NO_PRIORITY]: expect.any(String),
      },
    });
    expect(built.priorityLabels).toEqual(["80.Priority: High", "89.Priority: Low"]);
  });

  it("自動付与の対象外（運用ラベル・番号なし）は質問に含めない", () => {
    const built = buildLabelSuggestQuestions(availableLabels)!;
    const text = JSON.stringify(built.questions);

    expect(text).not.toContain("11.local");
    expect(text).not.toContain("71.manual-step");
    expect(text).not.toContain("enhancement");
  });

  it("優先度のラベルが無ければ優先度の質問を作らない", () => {
    const built = buildLabelSuggestQuestions([{ name: "30.bug", description: null }])!;

    expect(built.questions.priority).toBeUndefined();
  });

  it("対象のラベルが1つも無ければnull", () => {
    expect(buildLabelSuggestQuestions([{ name: "11.local", description: null }])).toBeNull();
    expect(buildLabelSuggestQuestions([])).toBeNull();
  });
});

describe("readLabelSuggestAnswers（#3245）", () => {
  const built = buildLabelSuggestQuestions([
    { name: "30.bug", description: null },
    { name: "31.security", description: null },
    { name: "50.feature", description: null },
    { name: "80.Priority: High", description: null },
  ])!;

  const noul = (value: number) => ({ type: "noul" as const, noul: value });
  const choice = (value: string) => ({
    type: "choice" as const,
    choice: value,
    confidence: 0.9,
    probabilities: {},
  });

  it(`確率が${JEV_LABEL_THRESHOLD}以上のラベルを、複数でも全て付ける`, () => {
    const labels = readLabelSuggestAnswers(
      {
        answers: {
          label_0: noul(0.9),
          label_1: noul(0.6),
          label_2: noul(0.1),
          priority: choice(JEV_NO_PRIORITY),
        },
      },
      built,
    );

    expect(labels).toEqual(["30.bug", "31.security"]);
  });

  it("どれもしきい値に届かないときは何も付けない（種別以外が最大確率になっても付けない。#3367）", () => {
    const labels = readLabelSuggestAnswers(
      {
        answers: {
          label_0: noul(0.2),
          // 3候補のうち最大確率なのは種別ではない31.security。以前はこれが最大というだけで
          // 付いていたが、種別かどうかを判定できないため付けない
          label_1: noul(0.4),
          label_2: noul(0.05),
          priority: choice(JEV_NO_PRIORITY),
        },
      },
      built,
    );

    expect(labels).toEqual([]);
  });

  it("優先度は選ばれたときだけ付け、「付けない」・候補外の答えは付けない", () => {
    const base = { label_0: noul(0.9), label_1: noul(0), label_2: noul(0) };

    expect(
      readLabelSuggestAnswers({ answers: { ...base, priority: choice("80.Priority: High") } }, built),
    ).toEqual(["30.bug", "80.Priority: High"]);
    expect(
      readLabelSuggestAnswers({ answers: { ...base, priority: choice(JEV_NO_PRIORITY) } }, built),
    ).toEqual(["30.bug"]);
    expect(
      readLabelSuggestAnswers({ answers: { ...base, priority: choice("99.Priority: Ghost") } }, built),
    ).toEqual(["30.bug"]);
  });

  it("読める答えが1つも無ければnull（呼び出し元がAIへ倒す）", () => {
    expect(readLabelSuggestAnswers({ answers: {} }, built)).toBeNull();
    expect(
      readLabelSuggestAnswers({ answers: { label_0: { type: "score", score: 1, confidence: 1, probabilities: {} } } }, built),
    ).toBeNull();
  });
});

describe("suggestLabelsByJev（#3245）", () => {
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.TYPESAFE_API_KEY;
    vi.unstubAllGlobals();
  });

  const availableLabels = [
    { name: "30.bug", description: "不具合" },
    { name: "50.feature", description: null },
  ];

  it("本文と質問をJevへ送り、付けるラベルを返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { label_0: { type: "noul", noul: 0.93 }, label_1: { type: "noul", noul: 0.02 } },
          usage: { input_tokens: 100, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const labels = await suggestLabelsByJev({ body: "ログインに失敗する", availableLabels });

    expect(labels).toEqual(["30.bug"]);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.state).toEqual({ 本文: "ログインに失敗する" });
    expect(Object.keys(sent.questions)).toEqual(["label_0", "label_1"]);
  });

  it("キー未設定なら呼ばずにnullを返す", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(suggestLabelsByJev({ body: "本文", availableLabels })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("対象のラベルが無ければ呼ばずにnullを返す", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      suggestLabelsByJev({ body: "本文", availableLabels: [{ name: "bug", description: null }] }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("エラー応答ならnullを返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));

    await expect(suggestLabelsByJev({ body: "本文", availableLabels })).resolves.toBeNull();
  });
});
