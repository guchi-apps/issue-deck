import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const yaml = readFileSync(new URL("../.github/workflows/reusable-claude-review-develop.yml", import.meta.url), "utf8");
const block = yaml.split("      - name: 実装担当からレビュー担当を取得する\n")[1].split("  review-provider-fallback:")[0];
const script = block.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "review-provider-"));
  writeFileSync(path.join(dir, "curl"), `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  *implementation-provider*) printf '%s' "$RESPONSE"; exit "$HTTP_EXIT" ;;
  *claude-model*) printf '%s' '{"aiExecutionProvider":"claude"}' ;;
  *) exit 99 ;;
esac
`);
  chmodSync(path.join(dir, "curl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(patch = {}) {
  const output = path.join(dir, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, APP_BASE_URL: "https://example.test",
    PROGRESS_REPORT_SECRET: "test", ISSUE_NUMBER: "4037", REPOSITORY: "guchi-apps/issue-deck",
    GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(dir, "summary"), CALLS: path.join(dir, "calls"),
    RESPONSE: '{"provider":"codex"}', HTTP_EXIT: "0", ...patch,
  } });
  return { ...result, output: readFileSync(output, "utf8") };
}
it.each(["claude", "codex"])("実装担当%sだけを選び共通設定を読まない", (provider) => {
  const result = run({ RESPONSE: JSON.stringify({ provider }) });
  expect(result.status).toBe(0);
  expect(result.output).toBe(`provider=${provider}\n`);
  expect(readFileSync(path.join(dir, "calls"), "utf8")).not.toContain("claude-model");
});
it.each([{ HTTP_EXIT: "22" }, { RESPONSE: '{"provider":"unknown"}' }, { RESPONSE: 'invalid' }, { PROGRESS_REPORT_SECRET: '' }])("不明・通信失敗で別担当へ切り替えない %j", (patch) => {
  const result = run(patch);
  expect(result.status).not.toBe(0);
  expect(result.output).toBe("");
});
it("IssueがないPRに限り共通設定を使う", () => {
  const result = run({ ISSUE_NUMBER: "" });
  expect(result.status).toBe(0);
  expect(result.output).toBe("provider=claude\n");
});
it("担当解決失敗を自動マージの許容skippedに含めない", () => {
  const gate = yaml.split("  auto-merge:\n")[1].split("    runs-on:")[0];
  expect(gate).toContain("review-provider, claude-review");
  expect(gate).toContain("needs.risk-check.outputs.needs-review != 'true' || needs.review-provider.result == 'success'");
});
