import { describe, expect, it } from "vitest";

import {
  conflictCheckUserClearedCommentBody,
  shouldClearConflictCheckUser,
  type ConflictCheckUserClearInput,
} from "./conflict-check-user-clear";

const CONFLICT_FALLBACK =
  "⚠️ developとのコンフリクト自動解消ステップが終了しましたが…\n\n<!-- issue-deck-source:claude-conflict-resolve -->\n\n<!-- issue-deck-fallback-notice -->";

const LABELED_AT = new Date("2026-10-21T21:43:55Z");

function at(seconds: number, body: string | null) {
  return { body, created_at: new Date(LABELED_AT.getTime() + seconds * 1000).toISOString() };
}

function input(overrides: Partial<ConflictCheckUserClearInput> = {}): ConflictCheckUserClearInput {
  return {
    checkUserReason: "blocked",
    mergeable: true,
    repairRunning: false,
    checkUserLabeledAt: LABELED_AT,
    comments: [at(-300, "実装しました"), at(-5, CONFLICT_FALLBACK)],
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

  it("確認待ちの後にコンフリクト解消が走り直して成功報告していても外す（#4917の形）", () => {
    const resolved = "解消しました\n\n<!-- issue-deck-source:claude-conflict-resolve -->";
    expect(
      shouldClearConflictCheckUser(
        input({ comments: [at(-5, CONFLICT_FALLBACK), at(600, resolved), at(900, resolved)] }),
      ),
    ).toBe(true);
  });

  it("確認待ちの後に人・別のワークフローが書いていれば外さない", () => {
    expect(
      shouldClearConflictCheckUser(
        input({ comments: [at(-5, CONFLICT_FALLBACK), at(60, "どうなってる？")] }),
      ),
    ).toBe(false);
    expect(
      shouldClearConflictCheckUser(
        input({
          comments: [at(-5, CONFLICT_FALLBACK), at(60, "x\n\n<!-- issue-deck-source:claude-ci-fix -->")],
        }),
      ),
    ).toBe(false);
  });

  it("確認待ちを付けたのが別の実行体なら、後からコンフリクト解消が書いていても外さない", () => {
    const ciFixGaveUp = "断念しました\n\n<!-- issue-deck-source:claude-ci-fix -->";
    const resolved = "解消しました\n\n<!-- issue-deck-source:claude-conflict-resolve -->";
    expect(
      shouldClearConflictCheckUser(
        input({ comments: [at(-5, ciFixGaveUp), at(600, resolved)] }),
      ),
    ).toBe(false);
  });

  it("起点が読めない（付与時刻が未記録・付与前のコメントが無い）なら外さない", () => {
    expect(shouldClearConflictCheckUser(input({ checkUserLabeledAt: null }))).toBe(false);
    expect(shouldClearConflictCheckUser(input({ comments: [] }))).toBe(false);
    expect(shouldClearConflictCheckUser(input({ comments: [at(-5, null)] }))).toBe(false);
  });

  it("外した報告コメントはコンフリクト解消のマーカーを持たない（外した後に再判定で拾わない）", () => {
    const body = conflictCheckUserClearedCommentBody("https://github.com/o/r/pull/1");
    expect(shouldClearConflictCheckUser(input({ comments: [at(-5, body)] }))).toBe(false);
    expect(body).toContain("<!-- issue-deck-source:conflict-sweep -->");
  });
});
