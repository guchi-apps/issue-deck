import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yaml = readFileSync(path.join(root, ".github/workflows/reusable-release-develop-to-main.yml"), "utf8");
const start = yaml.lastIndexOf('          git checkout -q --detach "$RC_BASE"');
const end = yaml.indexOf('          APPLIED=', start);
if (start < 0 || end < 0) throw new Error("正式バンプの実物が見つかりません");
const script = yaml.slice(start, end).split("\n").map((line) => line.slice(10)).join("\n");

it.each(["npm", "custom"])("%sの正式バンプは候補のscripts・依存・lockを保持し、同じ版でも再実行できる", (mode) => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-preserve-"));
  const run = (cmd, args, env = {}) => execFileSync(cmd, args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  const write = (name, data) => writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + "\n");
  const read = (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
  try {
    run("git", ["init", "-q"]);
    run("git", ["config", "user.name", "test"]);
    run("git", ["config", "user.email", "test@example.com"]);
    write("package.json", { name: "app", version: "1.0.0", scripts: { test: "node --test tests" } });
    write("package-lock.json", { name: "app", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "app", version: "1.0.0" } } });
    run("git", ["add", "."]); run("git", ["commit", "-qm", "main"]);
    run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    write("package.json", { name: "app", version: "1.0.0", scripts: { test: "node --test tests/*.test.js" }, dependencies: { example: "2.0.0" } });
    const dep = { version: "2.0.0", resolved: "https://example.test/example.tgz", integrity: "sha512-example" };
    write("package-lock.json", { name: "app", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "app", version: "1.0.0", dependencies: { example: "2.0.0" } }, "node_modules/example": dep } });
    run("git", ["add", "."]); run("git", ["commit", "-qm", "candidate"]);
    const sha = run("git", ["rev-parse", "HEAD"]).trim();
    const env = { RC_BASE: sha, NEW_VERSION: "1.0.1", VERSION_FILE: "package.json", BUMP_KIND: "patch", RELEASE_CHANGELOG: "test", RELEASE_USAGE: "", BUMP_COMMAND: mode === "custom" ? 'npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version' : "" };
    for (let i = 0; i < 2; i++) {
      run("bash", ["-ec", script], env);
      expect(read("package.json")).toMatchObject({ version: "1.0.1", scripts: { test: "node --test tests/*.test.js" }, dependencies: { example: "2.0.0" } });
      expect(read("package-lock.json").packages["node_modules/example"]).toEqual(dep);
      expect(read("package-lock.json").packages[""].version).toBe("1.0.1");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);
