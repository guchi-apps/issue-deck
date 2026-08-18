import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// 不足している自動修復callerの生成は `.github/scripts/propagate-repair-workflows.sh` が
// 雛形（`.github/templates/repair-callers/`）の置換で行う（#1948）。GitHub API を伴う部分
// （clone・PR作成）は切り離せないため、**置換のロジックだけ**を同じコマンド列で再現して確認する。
//
// ここを間違えると、他リポジトリへ**動かないワークフロー**を配ることになる。特に
// `with:` に写す入力は、再利用ワークフローが宣言していない名前を混ぜるとワークフローの
// 読み込み自体が失敗するため、写す範囲を固定しておく。
const SCRIPT = join(process.cwd(), ".github", "scripts", "propagate-repair-workflows.sh");
const TEMPLATE_DIR = join(process.cwd(), ".github", "templates", "repair-callers");

const TEMPLATES = [
  "claude-ci-fix.yml",
  "claude-conflict-resolve.yml",
  "claude-pr-repair.yml",
] as const;

/** 参照元。実際の caller（guchi-apps/aide）と同じ形にしてある */
const DISPATCH = `name: Claude Issue Dispatch

on:
  issues:
    types: [labeled]

jobs:
  dispatch:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-dispatch.yml@workflows/v23
    with:
      runtime-setup: node
      package-manager: npm
      # database-name は runtime-setup: node では使われないため指定しない。
      database-name: app_ci
      node-version: "24"
      prompts-ref: workflows/v23
    secrets: inherit
`;

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

/**
 * スクリプト本体から生成部分だけを取り出して実行する。
 * 参照元から写す行の抽出（grep）→ 雛形への差し込み（awk）→ プレースホルダ置換（sed）。
 */
function render(template: string, dispatch: string, ciWorkflow = "CI"): string {
  workspace = mkdtempSync(join(tmpdir(), "repair-callers-"));
  const dispatchPath = join(workspace, "claude-issue-dispatch.yml");
  const withPath = join(workspace, "with-inputs.txt");
  const outPath = join(workspace, template);
  writeFileSync(dispatchPath, dispatch);

  execFileSync(
    "bash",
    [
      "-c",
      `set -uo pipefail
TAG="$(grep -oE '^\\s*uses:.*@workflows/v[0-9]+' "${dispatchPath}" | grep -oE 'workflows/v[0-9]+' | head -1)"
grep -E "^      (runtime-setup|package-manager|node-version):" "${dispatchPath}" > "${withPath}"
awk -v marker='__WITH_INPUTS__' '
  FNR == NR { block = block $0 "\\n"; next }
  $0 ~ marker { printf "%s", block; next }
  { print }
' "${withPath}" "${join(TEMPLATE_DIR, template)}" \
  | sed -e "s|__TAG__|$TAG|g" -e "s|__CI_WORKFLOW__|${ciWorkflow}|g" > "${outPath}"`,
    ],
    { encoding: "utf8" },
  );

  return readFileSync(outPath, "utf8");
}

describe("propagate-repair-workflows.sh", () => {
  it("スクリプトの構文が正しい", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT])).not.toThrow();
  });

  it("雛形は配布対象の3ファイルぶんある", () => {
    for (const name of TEMPLATES) {
      expect(() => readFileSync(join(TEMPLATE_DIR, name), "utf8"), name).not.toThrow();
    }
  });
});

describe("callerの生成", () => {
  it("uses と prompts-ref が参照元と同じタグになる", () => {
    // **片方だけずれると、新しいワークフローで古いプロンプトが使われる**
    const body = render("claude-ci-fix.yml", DISPATCH);

    expect(body).toContain("reusable-claude-ci-fix.yml@workflows/v23");
    expect(body).toContain("prompts-ref: workflows/v23");
  });

  it("参照元の with: を写す", () => {
    const body = render("claude-conflict-resolve.yml", DISPATCH);

    expect(body).toContain("      runtime-setup: node");
    expect(body).toContain("      package-manager: npm");
    expect(body).toContain('      node-version: "24"');
  });

  it("再利用ワークフローが宣言していない入力は写さない", () => {
    // 宣言されていない入力を渡すと、ワークフローの読み込み自体が失敗する
    const body = render("claude-ci-fix.yml", DISPATCH);

    expect(body).not.toContain("database-name");
  });

  it("CIワークフローの名前を workflow_run の購読先へ差し込む", () => {
    // 名前で購読するため、`CI`固定にすると名前が違うリポジトリでは黙って発火しない
    const body = render("claude-conflict-resolve.yml", DISPATCH, "Tests");

    expect(body).toContain('      - "Tests"');
    expect(body).not.toContain("__CI_WORKFLOW__");
  });

  it("生成後にプレースホルダが残らない", () => {
    for (const name of TEMPLATES) {
      const body = render(name, DISPATCH);
      expect(body, name).not.toContain("__");
    }
  });

  it("pr-repair は workflow_dispatch の入力を再利用ワークフローへ渡す", () => {
    // 再利用ワークフロー内の inputs は workflow_call のものを指すため、明示的に渡す必要がある
    const body = render("claude-pr-repair.yml", DISPATCH);

    expect(body).toContain("pr-number: ${{ inputs.pr_number }}");
    expect(body).toContain("mode: ${{ inputs.mode }}");
  });
});
