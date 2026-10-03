// `PLAN_REVIEW`は`launch_and_report`を経由して`timeout`配下で起動する。
// モデルの環境変数をコマンド列へそのまま置くと、timeoutは代入ではなく実行ファイル名と解釈する。
// この境界を実行して固定し、Claude・Codex双方のモデル選択が起動失敗へ戻らないようにする。

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const poller = path.join(repoRoot, "scripts", "subpc-dispatch-poller.sh");
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function runPlanReview({ agent, claudeLocalModel = "auto", codexModel = "auto" }) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "plan-review-launch-"));
  tempDirs.push(tempDir);
  const launcher = path.join(tempDir, "launcher.sh");
  writeFileSync(
    launcher,
    '#!/usr/bin/env bash\nprintf "%s|%s|%s\\n" "${ISSUE_DECK_CLAUDE_MODEL:-}" "${ISSUE_DECK_CODEX_MODEL:-}" "$1"\n',
  );
  chmodSync(launcher, 0o755);

  const job = JSON.stringify({
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 3896,
    kind: "PLAN_REVIEW",
    agent,
    claudeLocalModel,
    codexModel,
  });
  const script = `
set -euo pipefail
eval "$(sed -n '/^run_job() {/,/^}/p' ${JSON.stringify(poller)})"
local_session_validate_target() { return 0; }
count_plan_review_sessions() { printf '0'; }
plan_review_session_name() { printf 'issue-deck-plan-review-3896'; }
launch_and_report() { shift 3; timeout 1 "$@"; }
MAX_PLAN_REVIEWS=0
PLAN_REVIEW_LAUNCHER=${JSON.stringify(launcher)}
run_job ${JSON.stringify(job)}
`;
  // テストを実行しているCodexセッション自身のモデル指定を持ち込まない。
  // `auto`のときに呼び出し元が変数を渡していないことも、空の環境から確かめる。
  return execFileSync(
    "env",
    [
      "-u",
      "ISSUE_DECK_CLAUDE_MODEL",
      "-u",
      "ISSUE_DECK_CODEX_MODEL",
      "bash",
      "-c",
      script,
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .at(-1);
}

describe("PLAN_REVIEWのモデル付き起動", () => {
  it("Claudeモデルをtimeout配下の環境変数として渡す", () => {
    expect(runPlanReview({ agent: "claude", claudeLocalModel: "sonnet" })).toBe("sonnet||--agent");
  });

  it("Codexモデルをtimeout配下の環境変数として渡す", () => {
    expect(runPlanReview({ agent: "codex", codexModel: "gpt-6-sol" })).toBe("|gpt-6-sol|--agent");
  });

  it("autoはCLIの既定に委ね、環境変数を渡さない", () => {
    expect(runPlanReview({ agent: "codex" })).toBe("||--agent");
  });
});
