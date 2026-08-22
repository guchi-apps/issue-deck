import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// 不足しているcallerの生成は `.github/scripts/propagate-repair-workflows.sh` が
// 雛形（`.github/templates/callers/`）の置換で行う（#1948・#1475）。GitHub API を伴う部分
// （clone・PR作成・リポジトリ設定）は切り離せないため、**置換のロジックだけ**を同じコマンド列で
// 再現して確認する。
//
// ここを間違えると、他リポジトリへ**動かないワークフロー**を配ることになる。特に
// `with:` に写す入力は、再利用ワークフローが宣言していない名前を混ぜるとワークフローの
// 読み込み自体が失敗するため、写す範囲を固定しておく。
const SCRIPT = join(process.cwd(), ".github", "scripts", "propagate-repair-workflows.sh");
const TEMPLATE_DIR = join(process.cwd(), ".github", "templates", "callers");

const TEMPLATES = [
  "claude-ci-fix.yml",
  "claude-conflict-resolve.yml",
  "claude-pr-repair.yml",
  "claude-review-develop.yml",
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
  workspace = mkdtempSync(join(tmpdir(), "callers-"));
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

  it("雛形は配布対象のファイルぶんある", () => {
    for (const name of TEMPLATES) {
      expect(() => readFileSync(join(TEMPLATE_DIR, name), "utf8"), name).not.toThrow();
    }
  });

  it("配布できるファイル名の許可リストが雛形と一致している", () => {
    // ここがずれると、画面から配ろうとしたファイルが黙ってスキップされる
    const script = readFileSync(SCRIPT, "utf8");
    for (const name of TEMPLATES) {
      expect(script, name).toContain(name);
    }
  });
});

/** `reusable-*.yml` が `workflow_call` で宣言している入力名 */
function declaredInputs(reusableFile: string): string[] {
  const source = readFileSync(join(process.cwd(), ".github", "workflows", reusableFile), "utf8");
  const inputs = /^ {4}inputs:\n((?: {6}\S.*\n|\n| {8}.*\n| {10}.*\n)*)/m.exec(source);
  if (!inputs) return [];
  return [...(inputs[1] as string).matchAll(/^ {6}([a-z][a-z0-9-]*):/gm)].map((m) => m[1] as string);
}

/** 生成された caller が `with:` で渡している入力名 */
function passedInputs(body: string): string[] {
  const withBlock = /^ {4}with:\n((?: {6}.*\n|\n| {8}.*\n)*)/m.exec(body);
  if (!withBlock) return [];
  return [...(withBlock[1] as string).matchAll(/^ {6}([a-z][a-z0-9-]*):/gm)].map((m) => m[1] as string);
}

describe("callerの生成", () => {
  it("渡す入力は、呼ぶ先の再利用ワークフローが宣言しているものだけ", () => {
    // **宣言されていない入力を渡すとワークフローの読み込み自体が失敗する。**
    // ジョブが1つも作られず、`gh run view`も「workflow file issue」としか出さない（#1181）。
    // 雛形ごとに呼ぶ先が違い、写す入力の要否も違う（#1475）ため、実物と突き合わせる
    for (const name of TEMPLATES) {
      const body = render(name, DISPATCH);
      const reusable = /uses:.*\/(reusable-[a-z-]+\.yml)@/.exec(body)?.[1];
      expect(reusable, name).toBeTruthy();

      const declared = declaredInputs(reusable as string);
      expect(declared.length, reusable).toBeGreaterThan(0);
      for (const passed of passedInputs(body)) {
        expect(declared, `${name} -> ${reusable}: ${passed}`).toContain(passed);
      }
    }
  });

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

  it("claude-review-develop.yml には with: を写さない", () => {
    // reusable-claude-review-develop.yml は runtime-setup 等を宣言していない。
    // 渡すとワークフローの読み込み自体が失敗する（#1475）
    const body = render("claude-review-develop.yml", DISPATCH);

    expect(body).not.toContain("runtime-setup");
    expect(body).not.toContain("package-manager");
    expect(body).not.toContain("node-version");
    expect(body).toContain("reusable-claude-review-develop.yml@workflows/v23");
    expect(body).toContain("prompts-ref: workflows/v23");
  });

  it("claude-review-develop.yml は内蔵パターンで拾えないリスクパスだけを渡す", () => {
    // 内蔵（.github/workflows/** ・.env* ・**/auth/** など）は書かない。
    // `.env.tpl` は内蔵の `(^|/)\.env` に当たらないため、ここで補う
    const body = render("claude-review-develop.yml", DISPATCH);

    expect(body).toContain("risk-paths:");
    expect(body).toContain("\\.env\\.tpl$");
    expect(body).toContain("secrets-manifest");
    expect(body).not.toContain("^\\.github/workflows/");
  });

  it("ルート以外の依存ファイルをリスクパスで補う", () => {
    // `dependency-check`はルートの`package.json`しか見ない。signalyは`backend/requirements.txt`
    // だけ、myroomはルートが空スタブで実体が`frontend/package.json`のため、
    // 補わないと依存の更新が一度もリスク判定されないまま自動マージされる（#1475）
    const body = render("claude-review-develop.yml", DISPATCH);
    const riskPaths = /^ {6}risk-paths: \|\n((?: {8}.*\n)+)/m.exec(body)?.[1] ?? "";
    const patterns = riskPaths
      .trim()
      .split("\n")
      .map((line) => line.trim().split(" :: ")[0] as string);

    const matches = (path: string) =>
      patterns.some((pattern) => new RegExp(pattern).test(path));

    expect(matches("backend/requirements.txt")).toBe(true);
    expect(matches("frontend/package.json")).toBe(true);
    expect(matches("deployment/nginx.conf")).toBe(true);
    // ルートの`package.json`は`dependency-check`の担当なので、ここでは拾わない
    expect(matches("package.json")).toBe(false);
    // 普通の実装PRを巻き込まない
    expect(matches("src/app/page.tsx")).toBe(false);
  });

  it("pr-repair は workflow_dispatch の入力を再利用ワークフローへ渡す", () => {
    // 再利用ワークフロー内の inputs は workflow_call のものを指すため、明示的に渡す必要がある
    const body = render("claude-pr-repair.yml", DISPATCH);

    expect(body).toContain("pr-number: ${{ inputs.pr_number }}");
    expect(body).toContain("mode: ${{ inputs.mode }}");
  });
});
