import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

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
  expect(kind("pnpm install --frozen-lockfile", 1)).toBe("dependency_install_failed");
  expect(kind("npm ci", 1)).toBe("dependency_install_failed");
  expect(kind("pnpm test", 1)).toBe("test_failed");
  expect(kind("pnpm test", 124)).toBe("timeout");
  expect(kind("pnpm test", 127)).toBe("setup_missing");
  expect(kind("pnpm run build:ci", 2)).toBe("test_failed");
});

test("証跡が無い・SHAが違うときは未実施として渡し、不合格にしない", () => {
  const root = mkdtempSync(path.join(tmpdir(), "evidence-"));
  const none = sh(`evidence_prompt_text o/r 1 ${BASE} ${HEAD}`, root);
  expect(none).toMatch(/まだありません/);
  expect(none).toMatch(/コードに不具合がある」でもありません/);
  // 旧headの証跡は新しいheadに再利用されない
  sh(`evidence_init o/r 1 ${BASE} ${HEAD}; evidence_finish "$(evidence_file o/r 1 ${BASE} ${HEAD})" passed`, root);
  const newHead = "c".repeat(40);
  expect(sh(`evidence_prompt_text o/r 1 ${BASE} ${newHead}`, root)).toMatch(/まだありません/);
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
  expect(out).toMatch(/統合状態/);
  expect(out).toMatch(/`pnpm install` → passed/);
  expect(out).toMatch(/`pnpm test` → failed.*test_failed/);
  expect(out).toMatch(/head単体: 未実施/);
  expect(out).toMatch(/結果: \*\*failed\*\*（種別: test_failed）/);
});

test("失敗ログの機密は証跡にもプロンプトにも出ない（#4629）", () => {
  const root = mkdtempSync(path.join(tmpdir(), "evidence-"));
  const log = path.join(root, "fail.log");
  writeFileSync(
    log,
    [
      "DATABASE_URL=postgres://user:pw123@db.example.com/app",
      "Authorization: Bearer abcdefghijklmnop1234",
      "token ghp_abcdefghijklmnopqrstuvwx",
      "FOO_SECRET=hunter2hunter2",
      "plain failure line",
    ].join("\n"),
  );
  const out = sh(
    `evidence_init o/r 1 ${BASE} ${HEAD}; f="$(evidence_file o/r 1 ${BASE} ${HEAD})";
     evidence_add_step "$f" 'pnpm test' failed 1 test_failed '${log}';
     cat "$f"; evidence_prompt_text o/r 1 ${BASE} ${HEAD}`,
    root,
  );
  for (const secret of ["pw123", "abcdefghijklmnop1234", "ghp_abcdefgh", "hunter2hunter2"]) {
    expect(out).not.toContain(secret);
  }
  expect(out).toContain("plain failure line");
});
