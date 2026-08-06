import { describe, expect, it } from "vitest";

import { QA_ANSWER_MARKER } from "@/lib/github/ask-claude";
import {
  commentSourceLabel,
  extractCommentSourceId,
  extractPlanType,
  resolveCommentSource,
} from "@/lib/github/comment-source";
import { FALLBACK_NOTICE_MARKER } from "@/lib/github/fallback-notice";

describe("extractPlanType", () => {
  it("implementマーカー付きコメントから'implement'を読み取る", () => {
    expect(extractPlanType({ body: "計画本文\n\n<!-- issue-deck-plan-type:implement -->" })).toBe(
      "implement",
    );
  });

  it("splitマーカー付きコメントから'split'を読み取る", () => {
    expect(extractPlanType({ body: "計画本文\n\n<!-- issue-deck-plan-type:split -->" })).toBe(
      "split",
    );
  });

  it("マーカーが無いコメントはnullを返す", () => {
    expect(extractPlanType({ body: "通常のコメント" })).toBeNull();
  });
});

describe("extractCommentSourceId", () => {
  it("issue-deck-sourceマーカー付きコメントからidを読み取る", () => {
    expect(
      extractCommentSourceId({
        body: "対応完了しました\n\n<!-- issue-deck-source:claude-issue-dispatch -->",
      }),
    ).toBe("claude-issue-dispatch");
  });

  it("マーカーが無いコメントはnullを返す", () => {
    expect(extractCommentSourceId({ body: "通常のコメント" })).toBeNull();
  });
});

describe("resolveCommentSource", () => {
  it("フォールバック通知を最優先で判定する", () => {
    const body = `⚠️ 実装ステップが終了しましたが...\n\n実行ログ: https://example.com\n\n${FALLBACK_NOTICE_MARKER}`;
    expect(resolveCommentSource({ body }, "github-actions[bot]")).toEqual({
      kind: "fallback-notice",
    });
  });

  it("質問への回答をフォールバック通知の次に判定する", () => {
    const body = `回答本文\n\n${QA_ANSWER_MARKER}`;
    expect(resolveCommentSource({ body }, "github-actions[bot]")).toEqual({ kind: "qa-answer" });
  });

  it("計画コメントを計画種別付きで判定する", () => {
    const body = "計画本文\n\n<!-- issue-deck-plan-type:split -->";
    expect(resolveCommentSource({ body }, "github-actions[bot]")).toEqual({
      kind: "plan",
      planType: "split",
    });
  });

  it("issue-deck-sourceマーカーをidとともに判定する", () => {
    const body = "対応完了しました\n\n<!-- issue-deck-source:issue-labels -->";
    expect(resolveCommentSource({ body }, "github-actions[bot]")).toEqual({
      kind: "source",
      id: "issue-labels",
    });
  });

  it("botログインだが該当マーカーが無いコメントは不明な自動投稿と判定する", () => {
    expect(resolveCommentSource({ body: "通常のコメント" }, "github-actions[bot]")).toEqual({
      kind: "unknown-automation",
    });
  });

  it("bot以外のログインで該当マーカーが無い場合はnullを返す（バッジなし）", () => {
    expect(resolveCommentSource({ body: "通常のコメント" }, "m-guchi")).toBeNull();
  });

  it("bot以外のログインでもマーカーがあれば判定する（issue-deck[bot]以外の想定外ケースの保険）", () => {
    const body = `回答本文\n\n${QA_ANSWER_MARKER}`;
    expect(resolveCommentSource({ body }, "m-guchi")).toEqual({ kind: "qa-answer" });
  });
});

describe("commentSourceLabel", () => {
  it("fallback-noticeを「自動処理（エラー通知）」に変換する", () => {
    expect(commentSourceLabel({ kind: "fallback-notice" })).toBe("自動処理（エラー通知）");
  });

  it("qa-answerを「Claude Code」に変換する", () => {
    expect(commentSourceLabel({ kind: "qa-answer" })).toBe("Claude Code");
  });

  it("plan(implement)を「Claude Code（計画）」に変換する", () => {
    expect(commentSourceLabel({ kind: "plan", planType: "implement" })).toBe(
      "Claude Code（計画）",
    );
  });

  it("plan(split)を「Claude Code（分割計画）」に変換する", () => {
    expect(commentSourceLabel({ kind: "plan", planType: "split" })).toBe(
      "Claude Code（分割計画）",
    );
  });

  it("source:claude-issue-dispatchを「Claude Code」に変換する", () => {
    expect(commentSourceLabel({ kind: "source", id: "claude-issue-dispatch" })).toBe(
      "Claude Code",
    );
  });

  it("source:issue-labelsを「自動処理」に変換する", () => {
    expect(commentSourceLabel({ kind: "source", id: "issue-labels" })).toBe("自動処理");
  });

  it("unknown-automationを「不明な自動投稿」に変換する", () => {
    expect(commentSourceLabel({ kind: "unknown-automation" })).toBe("不明な自動投稿");
  });
});
