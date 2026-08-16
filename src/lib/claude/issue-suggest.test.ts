import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildIssueSuggestPrompt,
  generateIssueSuggestion,
  matchSuggestedLabels,
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
        { name: "90.Close: duplicate", description: "重複のためクローズ" },
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
    expect(prompt).not.toContain("90.Close: duplicate");
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
      labels: ["30.bug", "71.manual-step", "11.local", "90.Close: duplicate", "21.plan-required"],
    });

    const result = await generateIssueSuggestion("dummy-token", {
      body: "本文",
      availableLabels: [
        { name: "30.bug", description: "不具合" },
        { name: "71.manual-step", description: "ユーザー自身の手作業が必要" },
        { name: "11.local", description: "ローカルで対応中" },
        { name: "90.Close: duplicate", description: "重複のためクローズ" },
        { name: "21.plan-required", description: "計画が必要" },
      ],
    });

    expect(result).toEqual({ title: "ログインに失敗する", labels: ["30.bug"] });
  });

  it("リポジトリに存在しないラベル名は落とす", async () => {
    mockClaudeResponse({ title: "タイトル", labels: ["30.bug", "40.unexpected"] });

    const result = await generateIssueSuggestion("dummy-token", {
      body: "本文",
      availableLabels: [{ name: "30.bug", description: "不具合" }],
    });

    expect(result.labels).toEqual(["30.bug"]);
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
