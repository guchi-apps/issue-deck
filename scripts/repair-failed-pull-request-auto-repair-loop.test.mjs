import { describe, expect, it } from "vitest";
import { shouldRollBackFailedMigration } from "./repair-failed-pull-request-auto-repair-loop.mjs";

const failed = { finished_at: null, rolled_back_at: null };
const done = { finished_at: new Date(), rolled_back_at: null };
const rolledBack = { finished_at: null, rolled_back_at: new Date() };

describe("shouldRollBackFailedMigration", () => {
  it("未実施・成功済み・解決済みには何もしない", () => {
    expect(shouldRollBackFailedMigration([], false)).toBe(false);
    expect(shouldRollBackFailedMigration([done], true)).toBe(false);
    expect(shouldRollBackFailedMigration([rolledBack], false)).toBe(false);
  });

  it("対象テーブルがない単一の失敗のみ再実行を許す", () => {
    expect(shouldRollBackFailedMigration([failed], false)).toBe(true);
    expect(shouldRollBackFailedMigration([rolledBack, failed], false)).toBe(true);
  });

  it("既存テーブルや矛盾する履歴では停止する", () => {
    expect(() => shouldRollBackFailedMigration([failed], true)).toThrow();
    expect(() => shouldRollBackFailedMigration([failed, failed], false)).toThrow();
    expect(() => shouldRollBackFailedMigration([done, failed], false)).toThrow();
  });
});
