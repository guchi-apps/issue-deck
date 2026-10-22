import { describe, expect, it } from "vitest";

import {
  conflictCheckUserClearedCommentBody,
  shouldClearConflictCheckUser,
  type ConflictCheckUserClearInput,
  type ConflictCheckUserTimelineEvent,
} from "./conflict-check-user-clear";

const BOT = "github-actions[bot]";

const CONFLICT_FALLBACK =
  "⚠️ developとのコンフリクト自動解消ステップが終了しましたが…\n\n<!-- issue-deck-source:claude-conflict-resolve -->\n\n<!-- issue-deck-fallback-notice -->";
const RESOLVED = "解消しました\n\n<!-- issue-deck-source:claude-conflict-resolve -->";
const CI_FIX_GAVE_UP = "断念しました\n\n<!-- issue-deck-source:claude-ci-fix -->";

function comment(body: string | null, login = BOT): ConflictCheckUserTimelineEvent {
  return { event: "commented", body, actor: { login } };
}

function labeled(name: string, login = BOT): ConflictCheckUserTimelineEvent {
  return { event: "labeled", label: { name }, actor: { login } };
}

function unlabeled(name: string, login = BOT): ConflictCheckUserTimelineEvent {
  return { event: "unlabeled", label: { name }, actor: { login } };
}

const CONFLICT_GAVE_UP: ConflictCheckUserTimelineEvent[] = [
  comment("実装しました", "guchi"),
  comment(CONFLICT_FALLBACK),
  labeled("00.check-user"),
  labeled("01.check-blocked"),
];

function input(overrides: Partial<ConflictCheckUserClearInput> = {}): ConflictCheckUserClearInput {
  return {
    checkUserReason: "blocked",
    mergeable: true,
    repairRunning: false,
    timeline: CONFLICT_GAVE_UP,
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
    expect(
      shouldClearConflictCheckUser(
        input({ timeline: [...CONFLICT_GAVE_UP, comment(RESOLVED), comment(RESOLVED)] }),
      ),
    ).toBe(true);
  });

  it("確認待ちの後に人・別のワークフローが書いていれば外さない", () => {
    expect(
      shouldClearConflictCheckUser(
        input({ timeline: [...CONFLICT_GAVE_UP, comment("どうなってる？", "guchi")] }),
      ),
    ).toBe(false);
    expect(
      shouldClearConflictCheckUser(
        input({ timeline: [...CONFLICT_GAVE_UP, comment("x\n\n<!-- issue-deck-source:claude-ci-fix -->")] }),
      ),
    ).toBe(false);
  });

  it("確認待ちを付けたのが別の実行体なら、後からコンフリクト解消が書いていても外さない", () => {
    expect(
      shouldClearConflictCheckUser(
        input({
          timeline: [
            comment(CI_FIX_GAVE_UP),
            labeled("00.check-user"),
            labeled("01.check-blocked"),
            comment(RESOLVED),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("付与から同期までの間にコンフリクト解消が書いても、付与の起点を取り違えない（#4931）", () => {
    // 以前は同期した時刻（付与より遅い）を付与時刻としていたため、この並びでコンフリクト解消の
    // コメントが「付与直前」に見え、CI修正が付けた確認待ちを外していた
    expect(
      shouldClearConflictCheckUser(
        input({
          timeline: [
            comment(CI_FIX_GAVE_UP),
            labeled("00.check-user"),
            labeled("01.check-blocked"),
            comment(RESOLVED),
            comment(RESOLVED),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("最後に付いた確認待ちで判定する（一度外れて別の実行体が付け直した）", () => {
    expect(
      shouldClearConflictCheckUser(
        input({
          timeline: [
            ...CONFLICT_GAVE_UP,
            unlabeled("00.check-user", "guchi"),
            comment(CI_FIX_GAVE_UP),
            labeled("00.check-user"),
            comment(RESOLVED),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("人が手で付けた確認待ちは、直前のコメントがコンフリクト解消でも外さない", () => {
    expect(
      shouldClearConflictCheckUser(
        input({ timeline: [comment(CONFLICT_FALLBACK), labeled("00.check-user", "guchi")] }),
      ),
    ).toBe(false);
  });

  it("付与の後に00.check-userが外されていれば外さない（DBと食い違っている）", () => {
    expect(
      shouldClearConflictCheckUser(
        input({ timeline: [...CONFLICT_GAVE_UP, unlabeled("00.check-user", "guchi")] }),
      ),
    ).toBe(false);
  });

  it("起点が読めない（付与イベントが無い・付与前のコメントが無い・付与者が不明）なら外さない", () => {
    expect(shouldClearConflictCheckUser(input({ timeline: [comment(CONFLICT_FALLBACK)] }))).toBe(false);
    expect(shouldClearConflictCheckUser(input({ timeline: [] }))).toBe(false);
    expect(shouldClearConflictCheckUser(input({ timeline: [labeled("00.check-user")] }))).toBe(false);
    expect(
      shouldClearConflictCheckUser(input({ timeline: [comment(null), labeled("00.check-user")] })),
    ).toBe(false);
    expect(
      shouldClearConflictCheckUser(
        input({
          timeline: [comment(CONFLICT_FALLBACK), { event: "labeled", label: { name: "00.check-user" } }],
        }),
      ),
    ).toBe(false);
  });

  it("外した報告コメントはコンフリクト解消のマーカーを持たない（外した後に再判定で拾わない）", () => {
    const body = conflictCheckUserClearedCommentBody("https://github.com/o/r/pull/1");
    expect(
      shouldClearConflictCheckUser(input({ timeline: [comment(body), labeled("00.check-user")] })),
    ).toBe(false);
    expect(body).toContain("<!-- issue-deck-source:conflict-sweep -->");
  });
});
