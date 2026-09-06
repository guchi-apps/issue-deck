import { describe, expect, it } from "vitest";

import {
  needsReviewAttention,
  parsePullRequestReviewVerdict,
} from "@/lib/github/pull-request-review-verdict";

/** `reusable-claude-review-develop.yml`が書く節そのままの形 */
function body(section: string): string {
  return ["実装しました。", "", "## 対応Issue", "", "#2843", "", section].join("\n");
}

const LGTM_SECTION = [
  "<!-- issue-deck-verification:start review=lgtm risk=none -->",
  "## 検証結果",
  "",
  "- 自動レビュー: ✅ 問題なし（LGTM）",
  "- 機械的リスク判定: 該当なし",
  "- ユーザーの確認: 不要（自動マージの対象）",
  "",
  "<sub>この節は`claude-review-develop.yml`が自動で更新します（#2448）。</sub>",
  "<!-- issue-deck-verification:end -->",
].join("\n");

describe("parsePullRequestReviewVerdict", () => {
  it("節が無い本文ではnullを返す", () => {
    expect(parsePullRequestReviewVerdict("## 対応Issue\n\n#2843")).toBeNull();
    expect(parsePullRequestReviewVerdict(null)).toBeNull();
    expect(parsePullRequestReviewVerdict("")).toBeNull();
  });

  it("LGTMの節から判定と文言を読む", () => {
    expect(parsePullRequestReviewVerdict(body(LGTM_SECTION))).toEqual({
      reviewKind: "ok",
      reviewLabel: "問題なし（LGTM）",
      riskKind: "none",
      riskLabel: "該当なし",
      riskReasons: [],
      confirmLabel: "不要（自動マージの対象）",
    });
  });

  it("要修正・リスク該当の節では理由まで拾う", () => {
    const section = [
      "<!-- issue-deck-verification:start review=changes-requested risk=hit -->",
      "## 検証結果",
      "",
      "- 自動レビュー: ❌ 要修正",
      "- 機械的リスク判定: ⚠️ 該当あり",
      "  - 認証・認可に関わる変更",
      "  - DBスキーマ変更・マイグレーション",
      "- ユーザーの確認: 必要（自動マージはスキップされます）",
      "<!-- issue-deck-verification:end -->",
    ].join("\n");

    expect(parsePullRequestReviewVerdict(body(section))).toEqual({
      reviewKind: "changes-requested",
      reviewLabel: "要修正",
      riskKind: "hit",
      riskLabel: "該当あり",
      riskReasons: ["認証・認可に関わる変更", "DBスキーマ変更・マイグレーション"],
      confirmLabel: "必要（自動マージはスキップされます）",
    });
  });

  it("レビューを省いた節は`skipped`として理由つきの文言を残す", () => {
    const section = [
      "<!-- issue-deck-verification:start review=skipped risk=none -->",
      "## 検証結果",
      "",
      "- 自動レビュー: — 実施なし（低リスクかつ小規模のため省略）",
      "- 機械的リスク判定: 該当なし",
      "- ユーザーの確認: 不要（自動マージの対象）",
      "<!-- issue-deck-verification:end -->",
    ].join("\n");

    const verdict = parsePullRequestReviewVerdict(body(section));
    expect(verdict?.reviewKind).toBe("skipped");
    expect(verdict?.reviewLabel).toBe("実施なし（低リスクかつ小規模のため省略）");
  });

  it("知らない`review=`の値はunknownへ倒し、文言はそのまま残す", () => {
    const section = [
      "<!-- issue-deck-verification:start review=unavailable risk=none -->",
      "## 検証結果",
      "",
      "- 自動レビュー: ? 判定を取得できませんでした",
      "- 機械的リスク判定: 該当なし",
      "<!-- issue-deck-verification:end -->",
    ].join("\n");

    const verdict = parsePullRequestReviewVerdict(body(section));
    expect(verdict?.reviewKind).toBe("unknown");
    expect(verdict?.reviewLabel).toBe("判定を取得できませんでした");
    expect(verdict?.confirmLabel).toBeNull();
  });

  it("節の外にある箇条書きは読まない", () => {
    const text = [
      "- 自動レビュー: ❌ 要修正",
      "",
      LGTM_SECTION,
      "",
      "- 機械的リスク判定: ⚠️ 該当あり",
    ].join("\n");

    const verdict = parsePullRequestReviewVerdict(text);
    expect(verdict?.reviewKind).toBe("ok");
    expect(verdict?.reviewLabel).toBe("問題なし（LGTM）");
    expect(verdict?.riskLabel).toBe("該当なし");
  });

  it("CRLFの本文でも読める", () => {
    expect(parsePullRequestReviewVerdict(body(LGTM_SECTION).replace(/\n/g, "\r\n"))?.reviewKind).toBe(
      "ok",
    );
  });
});

describe("needsReviewAttention", () => {
  it("要修正・要確認だけを人が読むべき判定として扱う", () => {
    expect(needsReviewAttention("changes-requested")).toBe(true);
    expect(needsReviewAttention("needs-check")).toBe(true);
    expect(needsReviewAttention("ok")).toBe(false);
    // 省略・記録なしは設計どおりの動き。ここをtrueにすると本当の指摘が埋もれる
    expect(needsReviewAttention("skipped")).toBe(false);
    expect(needsReviewAttention("unknown")).toBe(false);
  });
});
