import { describe, expect, it } from "vitest";
import { shouldRollBackFailedMigration } from "./repair-failed-dispatch-session-codex-thread-id.mjs";

const failed = { finished_at: null, rolled_back_at: null };
const applied = { finished_at: new Date(), rolled_back_at: null };
const rolledBack = { finished_at: null, rolled_back_at: new Date() };

describe("shouldRollBackFailedMigration", () => {
  it("失敗記録がなければ処理しない", () => {
    expect(shouldRollBackFailedMigration([], false)).toBe(false);
    expect(shouldRollBackFailedMigration([applied], true)).toBe(false);
    expect(shouldRollBackFailedMigration([rolledBack], false)).toBe(false);
  });

  it("列が存在しない単一の失敗記録だけを再試行可能にする", () => {
    expect(shouldRollBackFailedMigration([failed], false)).toBe(true);
    expect(() => shouldRollBackFailedMigration([failed], true)).toThrow(/column already exists/);
    expect(() => shouldRollBackFailedMigration([failed, failed], false)).toThrow(/unexpected migration history/);
    expect(() => shouldRollBackFailedMigration([failed, applied], false)).toThrow(/unexpected migration history/);
  });
});
