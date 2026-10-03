import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRollBackFailedMigration } from "./repair-failed-codex-weekly-floor.mjs";

const failed = { finished_at: null, rolled_back_at: null };
const applied = { finished_at: new Date(), rolled_back_at: null };
const rolledBack = { finished_at: null, rolled_back_at: new Date() };

test("失敗記録がなく、既に適用済みなら処理しない", () => {
  assert.equal(shouldRollBackFailedMigration([], false), false);
  assert.equal(shouldRollBackFailedMigration([applied], true), false);
  assert.equal(shouldRollBackFailedMigration([rolledBack], false), false);
});

test("列が存在しない単一の失敗記録だけを再試行可能にする", () => {
  assert.equal(shouldRollBackFailedMigration([failed], false), true);
  assert.throws(() => shouldRollBackFailedMigration([failed], true), /column already exists/);
  assert.throws(() => shouldRollBackFailedMigration([failed, failed], false), /unexpected migration history/);
  assert.throws(() => shouldRollBackFailedMigration([failed, applied], false), /unexpected migration history/);
});
