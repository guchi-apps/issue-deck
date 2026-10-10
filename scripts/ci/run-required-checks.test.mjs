import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const runner = path.resolve("scripts/ci/run-required-checks.mjs");

function run(checks, id = "build") {
  const dir = mkdtempSync(path.join(tmpdir(), "release-build-check-"));
  try {
    const manifest = path.join(dir, "checks.json");
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, groups: { build: { checks } } }));
    return spawnSync(process.execPath, [runner, "--group", "build", "--check", id, "--manifest", manifest], {
      cwd: dir,
      env: { ...process.env, GITHUB_APP_ID: "production-sentinel" },
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const build = {
  id: "build",
  run: 'node -e \'if(process.env.GITHUB_APP_ID !== "123456" || !process.cwd().includes("release-build-check-")) process.exit(9)\'',
  env: { GITHUB_APP_ID: "123456" },
};

describe("単独ビルドのCI環境適用", () => {
  it("他の検査を実行せず、検証用envで継承値を上書きして統合cwdを維持する", () => {
    const original = process.env.GITHUB_APP_ID;
    expect(run([{ id: "test", run: "exit 99" }, build]).status).toBe(0);
    expect(process.env.GITHUB_APP_ID).toBe(original);
  });
  it("ビルドの失敗を非ゼロで返す", () => {
    expect(run([{ ...build, run: "exit 7" }]).status).toBe(1);
  });
  it("存在しない検査を成功にしない", () => {
    expect(run([{ id: "test", run: "exit 0" }]).status).toBe(2);
  });
  it("重複する検査IDを拒否する", () => {
    expect(run([build, build]).status).toBe(2);
  });
  it("--checkの値なしを拒否する", () => {
    expect(run([build], "").status).toBe(2);
  });
});
