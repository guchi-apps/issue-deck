// `.github/workflows/reusable-claude-review-develop.yml`の「マージ保留の判定を反映する」ステップの
// うち、レビュー指摘の自動修正（`claude-review-fix.yml`）へ渡すかどうかの分岐を、GitHub CLIを
// スタブに差し替えて実行する（#3363）。
//
// **渡すと00.check-userを付けない**ため、条件を誤ると「要修正」のPRが人にも自動修正にも
// 拾われないまま残る。どれか1つでも満たさなければ従来どおり人へ渡ること（フェイルセーフ）を、
// 分岐ごとに確かめる。

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowYaml = readFileSync(
  path.join(repoRoot, ".github/workflows/reusable-claude-review-develop.yml"),
  "utf8",
);

/** ステップ名から`run: |`の本文を取り出す（`reusable-review-report.test.mjs`と同じ最小実装） */
function extractRunScript(stepName) {
  const lines = workflowYaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`ステップが見つかりません: ${stepName}`);

  const runIndex = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  if (runIndex < 0) throw new Error(`run: が見つかりません: ${stepName}`);

  const body = [];
  const indent = lines[runIndex].search(/\S/) + 2;
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

// 読み出しは環境変数の値を返し、書き込み（issue edit / issue comment）はログへ残す。
const STUB_GH = `#!/usr/bin/env bash
set -u
all="$*"
case "$1 $2" in
  "issue view")
    case "$all" in
      *"--json comments"*) printf '%s' "\${STUB_ISSUE_COMMENTS:-}" ;;
      *"--json labels"*) printf '%s' "\${STUB_LABELS:-}" ;;
    esac
    exit 0 ;;
  "pr view")
    case "$all" in
      *"--json comments"*) printf '%s' "\${STUB_PR_COMMENTS:-}" ;;
      *"--json merged"*) printf '%s' "\${STUB_MERGED:-false}" ;;
    esac
    exit 0 ;;
  "label list")
    printf '00.check-user\\n01.check-merge\\n01.check-blocked\\n'
    exit 0 ;;
  "issue edit")
    echo "EDIT $all" >> "$STUB_LOG"
    exit 0 ;;
  "issue comment")
    echo "COMMENT $all" >> "$STUB_LOG"
    exit 0 ;;
esac
if [ "$1" = "api" ]; then
  exit "\${STUB_CALLER_EXIT:-0}"
fi
exit 0
`;

const HEAD_SHA = "abc123";
const VERDICT = `<!-- issue-deck-review-verdict:merge-blocked sha=${HEAD_SHA} -->`;
const AUTOFIX = `<!-- issue-deck-review-autofix:ok sha=${HEAD_SHA} -->`;

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "review-fix-handoff-"));
  const ghPath = path.join(workDir, "gh");
  writeFileSync(ghPath, STUB_GH);
  chmodSync(ghPath, 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function run({
  issueComments = `理由\n${VERDICT}`,
  prComments = `## 総評\n要修正\n${AUTOFIX}`,
  labels = "",
  merged = "false",
  callerExit = "0",
  risky = "false",
  autoFix = "true",
} = {}) {
  const logPath = path.join(workDir, "gh.log");
  const outputPath = path.join(workDir, "output");
  writeFileSync(outputPath, "");
  execFileSync("bash", ["-e", "-c", extractRunScript("マージ保留の判定を反映する")], {
    env: {
      ...process.env,
      PATH: `${workDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputPath,
      GH_TOKEN: "dummy",
      GH_REPO: "guchi-apps/issue-deck",
      ISSUE_NUMBER: "3363",
      PR_NUMBER: "3400",
      HEAD_SHA,
      RISKY: risky,
      REASONS: risky === "true" ? "- **GitHub Actionsやデプロイ設定**: x" : "",
      ALREADY_CHECK_USER: "false",
      REVIEW_RESULT: "success",
      REVIEW_AUTO_FIX: autoFix,
      STUB_ISSUE_COMMENTS: issueComments,
      STUB_PR_COMMENTS: prComments,
      STUB_LABELS: labels,
      STUB_MERGED: merged,
      STUB_CALLER_EXIT: callerExit,
      STUB_LOG: logPath,
    },
    encoding: "utf8",
  });
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  return {
    handedOff: readFileSync(outputPath, "utf8").includes("handoff=true"),
    labeled: log.includes("EDIT") && log.includes("--add-label 00.check-user"),
    log,
  };
}

describe("レビュー指摘の自動修正への渡し（#3363）", () => {
  it("要修正で、レビューが自動修正OKの印を付けていれば、人へ渡さず自動修正へ渡す", () => {
    const result = run();
    expect(result.handedOff).toBe(true);
    expect(result.labeled).toBe(false);
    // claude-review-fix.ymlはこの印をいまのheadで探して着手する
    expect(result.log).toContain(`issue-deck-review-fix:handoff sha=${HEAD_SHA}`);
    expect(result.log).toContain("1/2回目");
  });

  it("自動修正OKの印が無ければ人へ渡す（フェイルセーフ）", () => {
    const result = run({ prComments: "## 総評\n要修正" });
    expect(result.handedOff).toBe(false);
    expect(result.labeled).toBe(true);
  });

  it("別のコミットに対する自動修正OKの印では渡さない", () => {
    const result = run({ prComments: "<!-- issue-deck-review-autofix:ok sha=old999 -->" });
    expect(result.handedOff).toBe(false);
    expect(result.labeled).toBe(true);
  });

  it("機械的リスク判定にも該当していれば人へ渡す", () => {
    const result = run({ risky: "true" });
    expect(result.handedOff).toBe(false);
    expect(result.labeled).toBe(true);
  });

  it("11.local・00.check-userが付いていれば人へ渡す", () => {
    expect(run({ labels: "11.local" }).handedOff).toBe(false);
    expect(run({ labels: "00.check-user" }).handedOff).toBe(false);
  });

  it("claude-review-fix.ymlが置かれていないリポジトリでは人へ渡す", () => {
    const result = run({ callerExit: "1" });
    expect(result.handedOff).toBe(false);
    expect(result.labeled).toBe(true);
  });

  it("PRが既にマージされていれば渡さない", () => {
    expect(run({ merged: "true" }).handedOff).toBe(false);
  });

  it("入力で無効にしていれば渡さない", () => {
    expect(run({ autoFix: "false" }).handedOff).toBe(false);
  });

  it("2回渡した後は人へ渡し、上限に達したことをIssueへ書く", () => {
    const issueComments = [
      VERDICT,
      "<!-- issue-deck-review-fix:handoff sha=aaa -->",
      "<!-- issue-deck-review-fix:handoff sha=bbb -->",
    ].join("\n");
    const result = run({ issueComments });
    expect(result.handedOff).toBe(false);
    expect(result.labeled).toBe(true);
    expect(result.log).toContain("2回試みましたが");
  });

  it("2回目の渡しは回数を数えて伝える", () => {
    const issueComments = `${VERDICT}\n<!-- issue-deck-review-fix:handoff sha=aaa -->`;
    const result = run({ issueComments });
    expect(result.handedOff).toBe(true);
    expect(result.log).toContain("2/2回目");
  });
});
