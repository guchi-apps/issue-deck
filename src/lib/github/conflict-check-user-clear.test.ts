import { describe, expect, it } from "vitest";

import {
  conflictCheckUserClearedCommentBody,
  shouldClearConflictCheckUser,
  type ConflictCheckUserClearInput,
} from "./conflict-check-user-clear";

const CONFLICT_FALLBACK =
  "⚠️ developとのコンフリクト自動解消ステップが終了しましたが…\n\n<!-- issue-deck-source:claude-conflict-resolve -->\n\n<!-- issue-deck-fallback-notice -->";

function input(overrides: Partial<ConflictCheckUserClearInput> = {}): ConflictCheckUserClearInput {
  return {
    checkUserReason: "blocked",
    mergeable: true,
    repairRunning: false,
    comments: [{ body: "実装しました" }, { body: CONFLICT_FALLBACK }],
    ...overrides,
  };
}

describe("shouldClearConflictCheckUser", () => {
  it("コンフリクトが消え、確認待ちの起点がコンフリクト解消なら外す", () => {
    expect(shouldClearConflictCheckUser(input())).toBe(true);
  });

  it("コンフリクトが残っている・未判定なら外さない", () => {
    expect(shouldClearConflictCheckUser(input({ mergeable: false }))).toBe(false);
    expect(shouldClearConflictCheckUser(input({ mergeable: null }))).toBe(false);
  });

  it("解消が走っている間は外さない", () => {
    expect(shouldClearConflictCheckUser(input({ repairRunning: true }))).toBe(false);
  });

  it("理由がblocked以外（マージ確認・計画の承認など）なら外さない", () => {
    expect(shouldClearConflictCheckUser(input({ checkUserReason: "merge" }))).toBe(false);
    expect(shouldClearConflictCheckUser(input({ checkUserReason: null }))).toBe(false);
  });

  it("最新コメントがコンフリクト解消以外（人・別のワークフロー）なら外さない", () => {
    expect(
      shouldClearConflictCheckUser(
        input({ comments: [{ body: CONFLICT_FALLBACK }, { body: "どうなってる？" }] }),
      ),
    ).toBe(false);
    expect(
      shouldClearConflictCheckUser(
        input({
          comments: [{ body: CONFLICT_FALLBACK }, { body: "x\n\n<!-- issue-deck-source:claude-ci-fix -->" }],
        }),
      ),
    ).toBe(false);
    expect(shouldClearConflictCheckUser(input({ comments: [] }))).toBe(false);
    expect(shouldClearConflictCheckUser(input({ comments: [{ body: null }] }))).toBe(false);
  });

  it("外した報告コメントはコンフリクト解消のマーカーを持たない（外した後に再判定で拾わない）", () => {
    const body = conflictCheckUserClearedCommentBody("https://github.com/o/r/pull/1");
    expect(shouldClearConflictCheckUser(input({ comments: [{ body }] }))).toBe(false);
    expect(body).toContain("<!-- issue-deck-source:conflict-sweep -->");
  });
});
