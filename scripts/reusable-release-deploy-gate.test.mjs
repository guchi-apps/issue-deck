// 実際のworkflowのdeploy-gateを実行し、失敗時の入口ごとの許可を確かめる（#3912）。
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(root, ".github/workflows/reusable-release-develop-to-main.yml"), "utf8");

function gateScript() {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === "- name: 直近の本番デプロイ失敗を確認する");
  if (start < 0) throw new Error("deploy-gateが見つかりません");
  const runIndex = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  if (runIndex < 0) throw new Error("deploy-gateのrunが見つかりません");
  const indent = lines[runIndex].search(/\S/) + 2;
  const body = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

function runGate({ conclusion = "failure", event = "schedule", override = false, needMainPr = false, fetchFails = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "release-deploy-gate-"));
  try {
    const gh = path.join(dir, "gh");
    const output = path.join(dir, "output");
    writeFileSync(gh, "#!/usr/bin/env bash\nif [ \"$STUB_FAIL\" = 1 ]; then exit 1; fi\nprintf '%s\\n' \"$STUB_RUNS\"\n");
    chmodSync(gh, 0o755);
    execFileSync("bash", ["-c", gateScript()], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        EVENT_NAME: event,
        ALLOW_FAILED_DEPLOY: String(override),
        NEED_MAIN_PR: String(needMainPr),
        STUB_FAIL: fetchFails ? "1" : "0",
        STUB_RUNS: JSON.stringify([{ status: "completed", conclusion }]),
      },
    });
    return readFileSync(output, "utf8").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("本番デプロイ失敗時のリリースゲート", () => {
  it("定時起動と通常の手動起動を止める", () => {
    expect(runGate()).toBe("ready=false");
    expect(runGate({ event: "workflow_dispatch" })).toBe("ready=false");
    expect(runGate({ event: "schedule", override: true })).toBe("ready=false");
  });

  it("明示的な手動上書きとバンプ後のpushを通す", () => {
    expect(runGate({ event: "workflow_dispatch", override: true })).toBe("ready=true");
    expect(runGate({ event: "push", needMainPr: true })).toBe("ready=true");
    expect(runGate({ event: "push" })).toBe("ready=false");
  });

  it("成功済みと取得失敗時は従来どおり通す", () => {
    expect(runGate({ conclusion: "success" })).toBe("ready=true");
    expect(runGate({ fetchFails: true })).toBe("ready=true");
  });
});
