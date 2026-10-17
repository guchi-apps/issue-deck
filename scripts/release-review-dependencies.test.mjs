import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let dir, source, candidate, output;
const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "shared-review-test-"));
  source = path.join(dir, "source");
  candidate = path.join(dir, "candidate");
  output = path.join(candidate, ".dependencies");
  mkdirSync(source);
  mkdirSync(path.join(candidate, ".github/workflows"), { recursive: true });
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  writeFileSync(path.join(source, "contract.yml"), "fixed contract\n");
  symlinkSync("/etc/passwd", path.join(source, "outside"));
  git("add", ".");
  git("commit", "-qm", "fixed");
  git("tag", "workflows/v52");
  writeFileSync(path.join(source, "contract.yml"), "new contract\n");
  git("commit", "-qam", "later");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(ref) {
  writeFileSync(path.join(candidate, ".github/workflows/release.yml"), `jobs:\n  release:\n    uses: guchi-apps/issue-deck/.github/workflows/release.yml@${ref}\n`);
  execFileSync("python3", ["scripts/release-review-dependencies.py", candidate, source, output]);
  return JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"));
}
it("固定タグを最新ブランチに置換せず、SHAと参照用コードを渡す。外部へのリンクは展開しない", () => {
  const [record] = run("workflows/v52");
  expect(record.sha).toBe(git("rev-parse", "workflows/v52"));
  expect(readFileSync(path.join(candidate, record.path, "contract.yml"), "utf8")).toBe("fixed contract\n");
  expect(record.skipped).toEqual(["outside"]);
  expect(existsSync(path.join(candidate, record.path, "outside"))).toBe(false);
});
it("完全SHAの取得結果が変わると再レビュー用指紋が変わる", () => {
  run("workflows/v52");
  const before = readFileSync(path.join(output, "fingerprint"), "utf8");
  const [record] = run(git("rev-parse", "HEAD"));
  expect(record.sha).toBe(git("rev-parse", "HEAD"));
  expect(readFileSync(path.join(output, "fingerprint"), "utf8")).not.toBe(before);
});
it("可変ブランチは取得済みにせず、理由を残す", () => {
  const [record] = run("develop");
  expect(record.error).toContain("自動取得対象外");
  expect(record.sha).toBeUndefined();
});
it("コメントのuses例とバッククォート付き説明文は依存参照にしない", () => {
  writeFileSync(path.join(candidate, ".github/workflows/examples.yml"), [
    "# uses: guchi-apps/issue-deck/.github/workflows/release.yml@workflows/vN",
    "  # `uses: guchi-apps/issue-deck/.github/workflows/release.yml@workflows/vN`",
    'description: "guchi-apps/issue-deck/.github/workflows/release.yml@workflows/vN"',
    "jobs:", "  release:",
    '    uses: "guchi-apps/issue-deck/.github/workflows/release.yml@workflows/v52" # fixed',
    "  other:",
    "    uses: 'guchi-apps/issue-deck/.github/workflows/release.yml@workflows/v52'",
    "",
  ].join("\n"));
  const records = run("workflows/v52");
  expect(records).toHaveLength(1);
  expect(records[0].ref).toBe("workflows/v52");
  expect(records[0].error).toBeUndefined();
});
