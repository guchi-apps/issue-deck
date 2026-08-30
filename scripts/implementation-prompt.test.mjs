import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 実装プロンプトの生成（`scripts/start-issue.sh`・`scripts/generic-start-issue.sh`）が、
 * **エージェントに合った計画の出し方**を書き込むことの確認（#2551・#2590）。
 *
 * Codexには`ExitPlanMode`が無く、計画は`submit-plan.sh`で登録する。ひな形に
 * Claude Code前提の手順（「フックが自動で投稿します／無ければ手で投稿します」）が残っていた
 * ときは、Codexのセッションがそちらに従って計画を`gh issue comment`で自分で投稿し、
 * 画面に承認パネルが出ないまま実装へ進んだ（#2550）。
 *
 * **汎用ランチャー（#1224）も同じ確認を通す**（#2590）。あちらのcwdは他リポジトリのworktreeで、
 * `submit-plan.sh`はそこに無いため、案内するパスは絶対でなければならない。
 *
 * 生成はbashのヒアドキュメントの中にあるので、`# prompt-render:start` /
 * `# prompt-render:end`で囲った範囲を切り出して直接実行する。マーカーを動かしたときは
 * ここが落ちる（黙って素通りしない）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(repoRoot, "scripts/prompts/implementation-agent.md");
const genericTemplate = path.join(repoRoot, "scripts/prompts/generic-implementation-agent.md");
// 汎用ランチャーが案内する`submit-plan.sh`の在り処（実行時は`LAUNCHER_SCRIPTS_DIR`）
const scriptsDir = "/home/user/apps/issue-deck/scripts";
let workDir;
let renderScript;
let genericRenderScript;
let issueJson;

function extractRenderScript(launcherPath) {
  const launcher = readFileSync(path.join(repoRoot, launcherPath), "utf8").split("\n");
  const start = launcher.findIndex((line) => line.includes("# prompt-render:start"));
  const end = launcher.findIndex((line) => line.includes("# prompt-render:end"));
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // 切り出すのは `<<'PY'` で始まるヒアドキュメントの中身だけ。**行数で数えない**——
  // 引数が多い呼び出しは`\`で複数行に折り返しているため（scripts/generic-start-issue.sh）
  const bodyStart = launcher.findIndex((line, i) => i > start && line.includes("<<'PY'"));
  expect(bodyStart).toBeGreaterThan(start);
  const bodyEnd = launcher.findIndex((line, i) => i > bodyStart && line === "PY");
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  expect(bodyEnd).toBeLessThan(end);
  return launcher.slice(bodyStart + 1, bodyEnd).join("\n");
}

function writeIssueJson(labels) {
  writeFileSync(
    issueJson,
    JSON.stringify({ number: 2551, title: "テスト", body: "本文", labels: labels.map((name) => ({ name })), comments: [] }),
    "utf8",
  );
}

function render(agent, labels = ["21.plan-required"]) {
  writeIssueJson(labels);
  return execFileSync(
    "python3",
    [renderScript, issueJson, template, "4552", "", "/tmp/dev.log", "0", "/tmp/wt", "rel", "cw", agent, scriptsDir],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function renderGeneric(agent, labels = ["21.plan-required"]) {
  writeIssueJson(labels);
  return execFileSync(
    "python3",
    [
      genericRenderScript,
      issueJson,
      genericTemplate,
      "guchi-apps/research-desk",
      "/tmp/wt",
      "develop",
      "pnpm",
      "pnpm dev",
      "4552",
      "rel",
      "cw",
      "/tmp/_docs",
      "0",
      "auto",
      agent,
      scriptsDir,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "impl-prompt-"));
  renderScript = path.join(workDir, "render.py");
  genericRenderScript = path.join(workDir, "render-generic.py");
  issueJson = path.join(workDir, "issue.json");
  writeFileSync(renderScript, extractRenderScript("scripts/start-issue.sh"), "utf8");
  writeFileSync(
    genericRenderScript,
    extractRenderScript("scripts/generic-start-issue.sh"),
    "utf8",
  );
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("実装プロンプトの生成", () => {
  it("Codexでは計画を`submit-plan.sh`で出すよう書く", () => {
    const prompt = render("codex");
    expect(prompt).toContain(`\`${scriptsDir}/submit-plan.sh <計画ファイル>\`を実行してください`);
    expect(prompt).toContain("**計画を`gh issue comment`で自分で投稿しないでください**");
    // Plan modeを前提にした手順が残っていると、そちらに従って手で投稿されてしまう
    expect(prompt).not.toContain("実装前にPlan modeで");
    expect(prompt).not.toContain("Plan modeの`ExitPlanMode`で計画を提示した場合");
  });

  it("Codexでは確認を`submit-question.sh`で画面へ出すよう書く", () => {
    const supplement = readFileSync(
      path.join(repoRoot, "scripts/prompts/codex-supplement.md"),
      "utf8",
    );
    expect(supplement).toContain(
      "`{{ISSUE_DECK_SCRIPTS_DIR}}/submit-question.sh <質問JSONファイル>`を実行してください",
    );
    expect(supplement).toContain("標準出力のanswers JSON");
    expect(supplement).not.toContain("確認が必要なときは端末で質問し");
  });

  it("Codexでは古いPlan mode・手動コメント投稿の指示を明示的に無効にする", () => {
    const supplement = readFileSync(
      path.join(repoRoot, "scripts/prompts/codex-supplement.md"),
      "utf8",
    );
    expect(supplement).toContain("「計画を`gh issue comment`で手動投稿する」という指示は実行しないでください");
    expect(supplement).toContain("subPCのセッションへ届きません");
    expect(supplement).toContain(
      "**必ず**`{{ISSUE_DECK_SCRIPTS_DIR}}/submit-plan.sh <計画ファイル>`を実行してください",
    );
  });

  it("読み替えは`submit-*.sh`を相対パスで案内しない（#2590）", () => {
    // 汎用ランチャーで起こすセッションのcwdは他リポジトリのworktreeで、そこには
    // issue-deckの`scripts/`が無い。相対で書くと必ず外れる
    const supplement = readFileSync(
      path.join(repoRoot, "scripts/prompts/codex-supplement.md"),
      "utf8",
    );
    expect(supplement).not.toContain("`scripts/submit-plan.sh");
    expect(supplement).not.toContain("`scripts/submit-question.sh");
  });

  it("Claude Codeでは質問送信コマンドを案内しない", () => {
    expect(render("claude")).not.toContain("submit-question.sh");
  });

  it("Claude Codeでは従来どおりPlan modeで出すよう書く", () => {
    const prompt = render("claude");
    expect(prompt).toContain("実装前にPlan modeで");
    expect(prompt).toContain("Plan modeの`ExitPlanMode`で計画を提示した場合");
    expect(prompt).not.toContain("submit-plan.sh");
  });

  it("どちらのエージェントでも未置換のプレースホルダを残さない", () => {
    for (const agent of ["claude", "codex"]) {
      expect(render(agent)).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });
});

describe("汎用ランチャーの実装プロンプトの生成（#2590）", () => {
  it("Codexでは計画を`submit-plan.sh`の絶対パスで出すよう書く", () => {
    const prompt = renderGeneric("codex");
    expect(prompt).toContain(`\`${scriptsDir}/submit-plan.sh <計画ファイル>\`を実行してください`);
    expect(prompt).toContain("**計画を`gh issue comment`で自分で投稿しないでください**");
    expect(prompt).not.toContain("実装前にPlan modeで");
    expect(prompt).not.toContain("Plan modeの`ExitPlanMode`で計画を提示した場合");
    // cwdは対象リポジトリのworktreeなので、相対では届かない
    expect(prompt).not.toContain("`scripts/submit-plan.sh");
  });

  it("Claude Codeでは従来どおりPlan modeで出すよう書く", () => {
    const prompt = renderGeneric("claude");
    expect(prompt).toContain("実装前にPlan modeで");
    expect(prompt).toContain("Plan modeの`ExitPlanMode`で計画を提示した場合");
    expect(prompt).not.toContain("submit-plan.sh");
  });

  it("どちらのエージェントでも未置換のプレースホルダを残さない", () => {
    for (const agent of ["claude", "codex"]) {
      expect(renderGeneric(agent)).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });
});
