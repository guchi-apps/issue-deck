// `.github/workflows/reusable-claude-review-develop.yml`の
// 「パスパターンによる機械的リスク判定とレビュー実行ゲート判定」ステップを、
// gitとGitHub CLIをスタブに差し替えて直接実行する（#2775）。
//
// このステップの出力`risky`が、そのままdevelop向けPRを自動マージするかどうかを決める
// （`auto-merge`ジョブが`00.check-user`を付けるか、`gh pr merge --auto`を打つか）。
// **緩めすぎても厳しすぎても赤くならない**——ワークフローは成功し、違いはマージが
// 止まるか止まらないかにしか出ないため、境界をここで固定しておく。
//
// 特に確かめたいのは`merge-policy: relaxed`（#2775）で、
//   - 変更カテゴリ（DBマイグレーション・ワークフロー・.env・認証・依存のメジャー更新）では止めない
//   - それでもレビューは実行する（止めるのをやめただけで、省いていない）
//   - `.shared-context/`の混入とIssueのラベルは緩和の対象外で、従来どおり止める
// の3点。

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github/workflows/reusable-claude-review-develop.yml");
const workflowYaml = readFileSync(workflowPath, "utf8");

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

// 判定に使うのは`git diff --name-only`（変更ファイル一覧）と`git diff --numstat`（差分規模）だけ。
// `git show origin/<ref>:package.json`は比較元の取得で、スタブでは常に失敗させる
// （package.jsonを触らないケースではそもそも呼ばれない）。
const STUB_GIT = `#!/usr/bin/env bash
set -u
if [ "\${1:-}" = "diff" ] && [ "\${2:-}" = "--name-only" ]; then
  printf '%s\\n' "\${STUB_CHANGED_FILES:-}"
  exit 0
fi
if [ "\${1:-}" = "diff" ] && [ "\${2:-}" = "--numstat" ]; then
  printf '%s\\n' "\${STUB_NUMSTAT:-}"
  exit 0
fi
exit 1
`;

// `gh issue view <番号> --json labels --jq '.labels[].name'`だけを使う。
const STUB_GH = `#!/usr/bin/env bash
set -u
printf '%s\\n' "\${STUB_LABELS:-}"
exit 0
`;

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "risk-check-"));
  for (const [name, body] of [
    ["git", STUB_GIT],
    ["gh", STUB_GH],
  ]) {
    const file = path.join(workDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * 判定ステップを走らせ、`$GITHUB_OUTPUT`へ書かれた値を返す。
 *
 * @param changedFiles 変更ファイル一覧（改行区切り）
 * @param labels 対応Issueに付いているラベル（改行区切り）
 * @param mergePolicy `merge-policy`入力の値。未指定なら既定のstrict
 */
function runRiskCheck({
  changedFiles = "src/app/page.tsx",
  numstat = null,
  labels = "",
  mergePolicy = "strict",
  issueNumber = "2775",
} = {}) {
  const outputPath = path.join(workDir, "github-output");
  const summaryPath = path.join(workDir, "step-summary");
  writeFileSync(outputPath, "");
  writeFileSync(summaryPath, "");

  const script = extractRunScript("パスパターンによる機械的リスク判定とレビュー実行ゲート判定");
  const stdout = execFileSync("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${workDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_RUN_ID: "1",
      GH_TOKEN: "dummy",
      ISSUE_NUMBER: issueNumber,
      BASE_REF: "develop",
      REVIEW_FILE_THRESHOLD: "10",
      REVIEW_LINE_THRESHOLD: "500",
      RISK_PATHS: "",
      DEPENDENCY_CHECK: "major",
      LOCK_FILES: "pnpm-lock.yaml package-lock.json",
      MERGE_POLICY: mergePolicy,
      STUB_CHANGED_FILES: changedFiles,
      // 既定は「1ファイル・2行」。閾値には遠く、レビュー実行の要否を汚さない
      STUB_NUMSTAT: numstat ?? changedFiles.split("\n").map((f) => `1\t1\t${f}`).join("\n"),
      STUB_LABELS: labels,
    },
    encoding: "utf8",
  });

  const output = readFileSync(outputPath, "utf8");
  const single = (key) => output.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? null;
  const reasons = output.match(/^reasons<<[^\n]*\n([\s\S]*?)\n[A-Z_0-9]+\n/m)?.[1] ?? "";

  return {
    risky: single("risky"),
    needsReview: single("needs-review"),
    reasons,
    stdout,
    summary: readFileSync(summaryPath, "utf8"),
  };
}

describe("merge-policy: strict（既定・従来どおり）", () => {
  it("DBマイグレーションの変更はマージを止める", () => {
    const result = runRiskCheck({ changedFiles: "prisma/migrations/20260101_x/migration.sql" });

    expect(result.risky).toBe("true");
    expect(result.reasons).toContain("DBマイグレーションの変更");
    expect(result.needsReview).toBe("true");
  });

  it("ワークフローの変更もマージを止める", () => {
    const result = runRiskCheck({ changedFiles: ".github/workflows/ci.yml" });

    expect(result.risky).toBe("true");
    expect(result.reasons).toContain("GitHub Actionsワークフローの変更");
  });
});

describe("merge-policy: relaxed（#2775）", () => {
  it("DBマイグレーション・ワークフロー・.env・認証の変更ではマージを止めない", () => {
    const result = runRiskCheck({
      mergePolicy: "relaxed",
      changedFiles: [
        "prisma/migrations/20260101_x/migration.sql",
        ".github/workflows/ci.yml",
        ".env.example",
        "src/lib/auth/session.ts",
      ].join("\n"),
    });

    expect(result.risky).toBe("false");
    // 理由はauto-mergeジョブが投稿するコメントの本文になる。止めないのだから空でなければならない
    expect(result.reasons).toBe("");
  });

  it("止めないだけで、レビューは従来どおり実行する", () => {
    const result = runRiskCheck({
      mergePolicy: "relaxed",
      changedFiles: "prisma/migrations/20260101_x/migration.sql",
    });

    expect(result.needsReview).toBe("true");
    expect(result.stdout).toContain("merge-policy: relaxed");
  });

  it("`.shared-context/`の混入は緩和の対象外で、従来どおり止める", () => {
    const result = runRiskCheck({
      mergePolicy: "relaxed",
      changedFiles: ".shared-context/CLAUDE.md",
    });

    expect(result.risky).toBe("true");
    expect(result.reasons).toContain(".shared-context");
  });

  it("`22.merge-confirm-required`が付いていれば従来どおり止める", () => {
    const result = runRiskCheck({
      mergePolicy: "relaxed",
      changedFiles: "src/app/page.tsx",
      labels: "51.improvement\n22.merge-confirm-required",
    });

    expect(result.risky).toBe("true");
    expect(result.reasons).toContain("22.merge-confirm-required");
  });

  it("どのカテゴリにも当たらない小さな差分は、従来どおりレビューもスキップする", () => {
    const result = runRiskCheck({ mergePolicy: "relaxed", changedFiles: "src/app/page.tsx" });

    expect(result.risky).toBe("false");
    expect(result.needsReview).toBe("false");
  });
});

describe("merge-policy の値の検証", () => {
  it("strict・relaxed 以外を渡すとジョブを失敗させる", () => {
    expect(() => runRiskCheck({ mergePolicy: "loose" })).toThrow();
  });

  it("未指定（空文字）はstrictとして扱う", () => {
    const result = runRiskCheck({
      mergePolicy: "",
      changedFiles: "prisma/migrations/20260101_x/migration.sql",
    });

    expect(result.risky).toBe("true");
  });
});
