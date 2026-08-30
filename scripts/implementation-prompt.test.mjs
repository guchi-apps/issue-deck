import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 実装プロンプトの生成（`scripts/start-issue.sh`）が、**エージェントに合った計画の出し方**を
 * 書き込むことの確認（#2551）。
 *
 * Codexには`ExitPlanMode`が無く、計画は`scripts/submit-plan.sh`で登録する。ひな形に
 * Claude Code前提の手順（「フックが自動で投稿します／無ければ手で投稿します」）が残っていた
 * ときは、Codexのセッションがそちらに従って計画を`gh issue comment`で自分で投稿し、
 * 画面に承認パネルが出ないまま実装へ進んだ（#2550）。
 *
 * 生成はbashのヒアドキュメントの中にあるので、`# prompt-render:start` /
 * `# prompt-render:end`で囲った範囲を切り出して直接実行する。マーカーを動かしたときは
 * ここが落ちる（黙って素通りしない）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(repoRoot, "scripts/prompts/implementation-agent.md");
let workDir;
let renderScript;
let issueJson;

function extractRenderScript() {
  const launcher = readFileSync(path.join(repoRoot, "scripts/start-issue.sh"), "utf8").split("\n");
  const start = launcher.findIndex((line) => line.includes("# prompt-render:start"));
  const end = launcher.findIndex((line) => line.includes("# prompt-render:end"));
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // 切り出すのは `python3 - …<<'PY'` の次の行から `PY` の手前まで
  return launcher.slice(start + 2, end - 1).join("\n");
}

function render(agent, labels = ["21.plan-required"]) {
  writeFileSync(
    issueJson,
    JSON.stringify({ number: 2551, title: "テスト", body: "本文", labels: labels.map((name) => ({ name })), comments: [] }),
    "utf8",
  );
  return execFileSync(
    "python3",
    [renderScript, issueJson, template, "4552", "", "/tmp/dev.log", "0", "/tmp/wt", "rel", "cw", agent],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "impl-prompt-"));
  renderScript = path.join(workDir, "render.py");
  issueJson = path.join(workDir, "issue.json");
  writeFileSync(renderScript, extractRenderScript(), "utf8");
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("実装プロンプトの生成", () => {
  it("Codexでは計画を`scripts/submit-plan.sh`で出すよう書く", () => {
    const prompt = render("codex");
    expect(prompt).toContain("`scripts/submit-plan.sh <計画ファイル>`を実行してください");
    expect(prompt).toContain("**計画を`gh issue comment`で自分で投稿しないでください**");
    // Plan modeを前提にした手順が残っていると、そちらに従って手で投稿されてしまう
    expect(prompt).not.toContain("実装前にPlan modeで");
    expect(prompt).not.toContain("Plan modeの`ExitPlanMode`で計画を提示した場合");
  });

  it("Codexでは確認を`scripts/submit-question.sh`で画面へ出すよう書く", () => {
    const supplement = readFileSync(
      path.join(repoRoot, "scripts/prompts/codex-supplement.md"),
      "utf8",
    );
    expect(supplement).toContain("`scripts/submit-question.sh <質問JSONファイル>`を実行してください");
    expect(supplement).toContain("標準出力のanswers JSON");
    expect(supplement).not.toContain("確認が必要なときは端末で質問し");
  });

  it("Claude Codeでは質問送信コマンドを案内しない", () => {
    expect(render("claude")).not.toContain("scripts/submit-question.sh");
  });

  it("Claude Codeでは従来どおりPlan modeで出すよう書く", () => {
    const prompt = render("claude");
    expect(prompt).toContain("実装前にPlan modeで");
    expect(prompt).toContain("Plan modeの`ExitPlanMode`で計画を提示した場合");
    expect(prompt).not.toContain("scripts/submit-plan.sh");
  });

  it("どちらのエージェントでも未置換のプレースホルダを残さない", () => {
    for (const agent of ["claude", "codex"]) {
      expect(render(agent)).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });
});
