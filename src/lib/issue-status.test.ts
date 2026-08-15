import { describe, expect, it } from "vitest";

import { isAttentionLabel, isProgressLabel, matchStatusStep } from "@/lib/issue-status";

describe("isProgressLabel", () => {
  it("00番台（要対応フラグ）を進捗ラベルと判定する", () => {
    expect(isProgressLabel("00.check-user")).toBe(true);
  });

  it("01〜09番台（ステップ運用）を進捗ラベルと判定する", () => {
    expect(isProgressLabel("01.planning")).toBe(true);
    expect(isProgressLabel("02.wip")).toBe(true);
    expect(isProgressLabel("09.main")).toBe(true);
  });

  it("00〜09番台以外は進捗ラベルと判定しない", () => {
    expect(isProgressLabel("21.plan-required")).toBe(false);
    expect(isProgressLabel("51.improvement")).toBe(false);
    expect(isProgressLabel("bug")).toBe(false);
  });
});

describe("isAttentionLabel / matchStatusStep との整合性", () => {
  it("isAttentionLabelまたはmatchStatusStepのいずれかがtrue/非nullならisProgressLabelもtrue", () => {
    const names = ["00.check-user", "02.wip", "21.plan-required", "51.improvement"];
    for (const name of names) {
      expect(isProgressLabel(name)).toBe(isAttentionLabel(name) || matchStatusStep(name) !== null);
    }
  });
});

describe("01.check-*（00.check-userの理由ラベル。#1490）", () => {
  it("進捗ステップとして扱わない（詳細のラベル欄に「ステップ1/9」の進捗バーを出さないため）", () => {
    for (const name of [
      "01.check-plan",
      "01.check-input",
      "01.check-merge",
      "01.check-blocked",
      "01.check-answered",
    ]) {
      expect(matchStatusStep(name)).toBeNull();
    }
    // 番号の形が同じでも、廃止済みの進捗ラベルは従来どおりステップとして読む
    expect(matchStatusStep("01.planning")).toBe(1);
  });

  it("要対応ラベルとして扱う（一覧カードのラベル一覧・ラベル選択欄から外す）", () => {
    expect(isAttentionLabel("01.check-plan")).toBe(true);
    expect(isProgressLabel("01.check-plan")).toBe(true);
  });
});
