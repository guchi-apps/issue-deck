import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const lib = path.resolve(import.meta.dirname, "lib/release-evidence.sh");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function sh(script, root) {
  return execFileSync("bash", ["-c", `source "${lib}"; ${script}`], {
    env: { ...process.env, ISSUE_DECK_RELEASE_EVIDENCE_ROOT: root },
    encoding: "utf8",
  });
}

test("失敗の種別を区別する", () => {
  const root = mkdtempSync(path.join(tmpdir(), "evidence-"));
  const kind = (cmd, code) => sh(`evidence_classify_step '${cmd}' ${code}`, root);
  assert.equal(kind("pnpm install --frozen-lockfile", 1), "dependency_install_failed");
  assert.equal(kind("npm ci", 1), "dependency_install_failed");
  assert.equal(kind("pnpm test", 1), "test_failed");
  assert.equal(kind("pnpm test", 124), "timeout");
  assert.equal(kind("pnpm test", 127), "setup_missing");
  assert.equal(kind("pnpm run build:ci", 2), "test_failed");
});

test("証跡が無い・SHAが違うときは未実施として渡し、不合格にしない", () => {
  const root = mkdtempSync(path.join(tmpdir(), "evidence-"));
  const none = sh(`evidence_prompt_text o/r 1 ${BASE} ${HEAD}`, root);
  assert.match(none, /まだありません/);
  assert.match(none, /コードに不具合がある」でもありません/);
  // 旧headの証跡は新しいheadに再利用されない
  sh(`evidence_init o/r 1 ${BASE} ${HEAD}; evidence_finish "$(evidence_file o/r 1 ${BASE} ${HEAD})" passed`, root);
  const newHead = "c".repeat(40);
  assert.match(sh(`evidence_prompt_text o/r 1 ${BASE} ${newHead}`, root), /まだありません/);
});

test("一致する証跡はコマンド・種別・統合状態つきで渡す", () => {
  const root = mkdtempSync(path.join(tmpdir(), "evidence-"));
  const out = sh(
    `evidence_init o/r 1 ${BASE} ${HEAD}; f="$(evidence_file o/r 1 ${BASE} ${HEAD})";
     evidence_add_step "$f" 'pnpm install' passed 0 '' '';
     evidence_add_step "$f" 'pnpm test' failed 1 test_failed /dev/null;
     evidence_finish "$f" failed test_failed '失敗したコマンド: pnpm test';
     evidence_prompt_text o/r 1 ${BASE} ${HEAD}`,
    root,
  );
  assert.match(out, /統合状態/);
  assert.match(out, /`pnpm install` → passed/);
  assert.match(out, /`pnpm test` → failed.*test_failed/);
  assert.match(out, /head単体: 未実施/);
  assert.match(out, /結果: \*\*failed\*\*（種別: test_failed）/);
});
