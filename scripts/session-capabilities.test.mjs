// `scripts/lib/session-capabilities.sh`の出力形式と「偽らない」性質を確かめる（#4522）。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/lib/session-capabilities.sh");

function probe(env = {}) {
  const out = execFileSync("bash", [script], {
    encoding: "utf8",
    env: { ...process.env, CAPABILITY_TIMEOUT_SECONDS: "5", ...env },
  });
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => {
        const [name, state, detail] = line.split("\t");
        return [name, { state, detail }];
      }),
  );
}

// 実測プローブはgh・ssh・ヘッドレス起動・npxを順に試すため、各5秒の上限でも既定の5秒では収まらない。
// 全プローブが上限まで待たされる最悪ケース（20秒）×最大2回に余裕を足した値にする。
const PROBE_TEST_TIMEOUT_MS = 60_000;

describe("session-capabilities.sh（#4522）", () => {
  it("状態はok/missing/unverifiedのどれかで、詳細を伴う", () => {
    const rows = probe();
    for (const name of ["gh", "vps-ssh", "browser-binary", "browser-driver", "browser-login"]) {
      expect(["ok", "missing", "unverified"]).toContain(rows[name].state);
      expect(rows[name].detail.length).toBeGreaterThan(0);
    }
  }, PROBE_TEST_TIMEOUT_MS);

  it("接続先が未設定ならVPSのSSHを確認済みにしない", () => {
    expect(probe({ MANUAL_STEP_VPS_SSH_TARGET: "" })["vps-ssh"].state).toBe("missing");
  }, PROBE_TEST_TIMEOUT_MS);

  it("プロファイルが無ければログインを確認済みにせず、あっても未確認止まり", () => {
    expect(probe({ ISSUE_DECK_BROWSER_PROFILE_DIR: "/nonexistent/profile" })["browser-login"].state).toBe("missing");
    expect(probe({ ISSUE_DECK_BROWSER_PROFILE_DIR: "/tmp" })["browser-login"].state).toBe("unverified");
  }, PROBE_TEST_TIMEOUT_MS);
});
