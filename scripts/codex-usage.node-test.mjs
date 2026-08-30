import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function run(fixture) {
  return execFileSync(
    "bash",
    ["-c", 'source scripts/lib/codex-usage.sh; codex_usage_latest "$1"', "bash", fixture],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

test("最新の正しいrate_limitsだけを抽出する", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "codex-usage-"));
  try {
    const day = path.join(fixture, "2026", "08", "30");
    mkdirSync(day, { recursive: true });
    const rateLimits = (used) => ({
      limit_id: "codex",
      primary: { used_percent: used, window_minutes: 300, resets_at: 1788081651 },
      secondary: { used_percent: 7, window_minutes: 10080, resets_at: 1788668451 },
      credits: { balance: "secret-like-value" },
      plan_type: "plus",
    });
    writeFileSync(
      path.join(day, "rollout.jsonl"),
      [
        JSON.stringify({ timestamp: "2026-08-30T06:00:00Z", payload: { type: "token_count", rate_limits: rateLimits(40), message: "本文" } }),
        "broken { token_count rate_limits",
        JSON.stringify({ timestamp: "2026-08-30T06:10:00Z", payload: { type: "token_count", rate_limits: rateLimits(45), message: "本文2" } }),
      ].join("\n"),
    );
    const result = JSON.parse(run(fixture));
    assert.equal(result.primary.usedPercent, 45);
    assert.equal(result.observedAt, "2026-08-30T06:10:00Z");
    assert.equal(JSON.stringify(result).includes("本文"), false);
    assert.equal(JSON.stringify(result).includes("secret-like-value"), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("読める枠が無ければ空で返す", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "codex-usage-empty-"));
  try {
    writeFileSync(path.join(fixture, "rollout.jsonl"), "{}\n");
    assert.equal(run(fixture), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
