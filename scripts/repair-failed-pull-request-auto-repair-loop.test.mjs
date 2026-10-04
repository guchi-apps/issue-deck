import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRollBackFailedMigration } from "./repair-failed-pull-request-auto-repair-loop.mjs";
const failed = { finished_at: null, rolled_back_at: null };
const done = { finished_at: new Date(), rolled_back_at: null };
const rolledBack = { finished_at: null, rolled_back_at: new Date() };
test("未実施・成功済み・解決済みには何もしない", () => {
  assert.equal(shouldRollBackFailedMigration([], false), false);
  assert.equal(shouldRollBackFailedMigration([done], true), false);
  assert.equal(shouldRollBackFailedMigration([rolledBack], false), false);
});
test("対象テーブルがない単一の失敗のみ再実行を許す", () => {
  assert.equal(shouldRollBackFailedMigration([failed], false), true);
  assert.equal(shouldRollBackFailedMigration([rolledBack, failed], false), true);
});
test("既存テーブルや矛盾する履歴では停止する", () => {
  assert.throws(() => shouldRollBackFailedMigration([failed], true));
  assert.throws(() => shouldRollBackFailedMigration([failed, failed], false));
  assert.throws(() => shouldRollBackFailedMigration([done, failed], false));
});
