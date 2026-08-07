import { describe, expect, it } from "vitest";

import { QA_ANSWER_MARKER } from "@/lib/github/ask-claude";
import {
  COMMENT_AGENT_PROFILES,
  commentAgentRole,
  extractAgentMarker,
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

describe("extractAgentMarker", () => {
  it("issue-deck-agentマーカー付きコメントから役割を読み取る", () => {
    expect(
      extractAgentMarker({ body: "実装しました\n\n<!-- issue-deck-agent:implementer -->" }),
    ).toBe("implementer");
    expect(extractAgentMarker({ body: "分割しました\n\n<!-- issue-deck-agent:splitter -->" })).toBe(
      "splitter",
    );
    expect(extractAgentMarker({ body: "ご案内します\n\n<!-- issue-deck-agent:guide -->" })).toBe(
      "guide",
    );
  });

  it("マーカーが無いコメントはnullを返す", () => {
    expect(extractAgentMarker({ body: "通常のコメント" })).toBeNull();
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

  it("issue-deck-agentマーカーを計画・質問回答・フォールバック通知より後、issue-deck-sourceより前に判定する", () => {
    const body =
      "着手します\n\n<!-- issue-deck-agent:implementer -->\n\n<!-- issue-deck-source:claude-issue-dispatch -->";
    expect(resolveCommentSource({ body }, "github-actions[bot]")).toEqual({
      kind: "agent",
      role: "implementer",
    });
  });

  it("issue-deck-sourceマーカーをidとともに判定する", () => {
    const body = "対応完了しました\n\n<!-- issue-deck-source:issue-labels -->";
    expect(resolveCommentSource({ body }, "github-actions[bot]")).toEqual({
      kind: "source",
      id: "issue-labels",
    });
  });

  it("マーカーが無い過去コメントを書き出しの絵文字からフォールバック推測する", () => {
    expect(resolveCommentSource({ body: "🔧 実装が完了しました" }, "github-actions[bot]")).toEqual({
      kind: "emoji-fallback",
      role: "implementer",
    });
    expect(resolveCommentSource({ body: "🔍 計画を検討します" }, "claude[bot]")).toEqual({
      kind: "emoji-fallback",
      role: "planner",
    });
    expect(resolveCommentSource({ body: "🔀 サブIssueに分割します" }, "claude[bot]")).toEqual({
      kind: "emoji-fallback",
      role: "splitter",
    });
    expect(resolveCommentSource({ body: "ℹ️ ご案内します" }, "github-actions[bot]")).toEqual({
      kind: "emoji-fallback",
      role: "guide",
    });
  });

  it("botログインだが該当マーカー・絵文字が無いコメントは不明な自動投稿と判定する", () => {
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

describe("commentAgentRole", () => {
  it("fallback-noticeをerror-notifierに変換する", () => {
    expect(commentAgentRole({ kind: "fallback-notice" })).toBe("error-notifier");
  });

  it("qa-answerをresponderに変換する", () => {
    expect(commentAgentRole({ kind: "qa-answer" })).toBe("responder");
  });

  it("plan(implement)をplannerに変換する", () => {
    expect(commentAgentRole({ kind: "plan", planType: "implement" })).toBe("planner");
  });

  it("plan(split)をsplitterに変換する", () => {
    expect(commentAgentRole({ kind: "plan", planType: "split" })).toBe("splitter");
  });

  it("agentマーカーの役割をそのまま返す", () => {
    expect(commentAgentRole({ kind: "agent", role: "guide" })).toBe("guide");
  });

  it("source:claude-review-developをreviewerに変換する", () => {
    expect(commentAgentRole({ kind: "source", id: "claude-review-develop" })).toBe("reviewer");
  });

  it("source:claude-conflict-resolveをconflict-resolverに変換する", () => {
    expect(commentAgentRole({ kind: "source", id: "claude-conflict-resolve" })).toBe(
      "conflict-resolver",
    );
  });

  it("source:issue-labelsをnotifierに変換する", () => {
    expect(commentAgentRole({ kind: "source", id: "issue-labels" })).toBe("notifier");
  });

  it("source:claude-issue-dispatch単独では役割を特定できずnullを返す（agentマーカー・絵文字での判別が前提のため）", () => {
    expect(commentAgentRole({ kind: "source", id: "claude-issue-dispatch" })).toBeNull();
  });

  it("emoji-fallbackの役割をそのまま返す", () => {
    expect(commentAgentRole({ kind: "emoji-fallback", role: "implementer" })).toBe("implementer");
  });

  it("unknown-automationはnullを返す（汎用ボット扱い）", () => {
    expect(commentAgentRole({ kind: "unknown-automation" })).toBeNull();
  });
});

describe("COMMENT_AGENT_PROFILES", () => {
  it("commentAgentRole()が返しうる全ての役割に表示名・アイコン・色が定義されている", () => {
    const roles = [
      "planner",
      "splitter",
      "implementer",
      "responder",
      "guide",
      "reviewer",
      "conflict-resolver",
      "notifier",
      "error-notifier",
    ] as const;
    for (const role of roles) {
      expect(COMMENT_AGENT_PROFILES[role].label).toBeTruthy();
      expect(COMMENT_AGENT_PROFILES[role].icon).toBeTruthy();
      expect(COMMENT_AGENT_PROFILES[role].avatarColor).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
