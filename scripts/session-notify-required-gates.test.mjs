// `21.plan-required`・`25.artifact-required`付きのセッションで、計画・デザインを出さずに
// 実装へ進ませない関門（#4944）を固定する。
//
// guchi-apps/yoteiflow#1321では両ラベルが起動前から付いていたのに、Plan modeにもアーティファクトにも
// 触れないまま2分でPRまで進んだ。守っているのは次のとおり。
//
//   1. 提示が転記に無い間は、worktree内の`Edit`・`Write`と`git commit`・`gh pr create`を拒否する
//   2. 計画の承認・アーティファクトの公開が同じworktreeの転記（前の転記を含む）にあれば通す
//   3. worktree外・`.html`の`Write`、読み取りのコマンドは通す
//   4. Issueのラベルが外れていれば通す（人が外せば解ける逃げ道）
//   5. `ISSUE_DECK_REQUIRED_GATES`が無いセッションには何もしない

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/session-notify.sh");

let workDir;
let worktree;
let projectDir;
let binDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "session-notify-required-gates-"));
  worktree = path.join(workDir, "worktree");
  projectDir = path.join(workDir, "projects", "worktree");
  binDir = path.join(workDir, "bin");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(workDir, "notify.env"), "");
  writeFileSync(path.join(workDir, "dispatch.env"), "");
  setIssueLabels(["21.plan-required", "25.artifact-required"]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** `gh issue view`の代わりに、Issueに今付いているラベルを返す */
function setIssueLabels(labels) {
  const gh = path.join(binDir, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\n' ${labels.map((l) => `'${l}'`).join(" ")}\n`);
  chmodSync(gh, 0o755);
}

function writeTranscript(name, records) {
  const file = path.join(projectDir, name);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

const toolUse = (id, name, input) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id, content, isError = false) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
});

const planApproved = [
  toolUse("toolu_plan", "ExitPlanMode", {}),
  toolResult("toolu_plan", "User has approved your plan. You can now start coding."),
  { type: "attachment", attachment: { type: "plan_mode_exit" } },
];
const artifactPublished = [
  toolUse("toolu_art", "Artifact", { file_path: "/tmp/scratch/design.html" }),
  toolResult("toolu_art", "Published: https://claude.ai/artifact/XxWDfT8h7LawipKxDoz8nd"),
];

function runHook(toolName, toolInput, { gates = "plan,artifact", transcript } = {}) {
  const transcriptPath = transcript ?? writeTranscript("current.jsonl", []);
  const hook = {
    hook_event_name: "PreToolUse",
    session_id: "s",
    transcript_path: transcriptPath,
    cwd: worktree,
    tool_name: toolName,
    tool_input: toolInput,
  };
  let stdout = "";
  const child = execFile("bash", [script, "4944", "issue-deck", "guchi-apps/issue-deck"], {
    encoding: "utf8",
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: workDir,
      TMUX: "",
      SESSION_NOTIFY_TMUX_SESSION: "",
      SESSION_NOTIFY_DRY_RUN: "1",
      ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "dispatch.env"),
      ISSUE_DECK_NOTIFY_ENV: path.join(workDir, "notify.env"),
      ISSUE_DECK_REQUIRED_GATES: gates,
    },
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
  child.stdin.end(JSON.stringify(hook));
  return done;
}

function denial(stdout) {
  const line = stdout
    .trim()
    .split("\n")
    .find((l) => l.startsWith("{"));
  if (!line) return null;
  const parsed = JSON.parse(line);
  return parsed.hookSpecificOutput?.permissionDecision === "deny" ? parsed.hookSpecificOutput : null;
}

describe("計画・デザイン提示の関門（#4944）", () => {
  it("提示が無い間は、worktree内のEditを両方の理由つきで拒否する", async () => {
    const result = denial(await runHook("Edit", { file_path: path.join(worktree, "src/a.ts") }));
    expect(result).not.toBeNull();
    expect(result.permissionDecisionReason).toContain("25.artifact-required");
    expect(result.permissionDecisionReason).toContain("21.plan-required");
  });

  it("相対パスのWriteとgit commit・gh pr createも拒否する", async () => {
    expect(denial(await runHook("Write", { file_path: "src/a.ts", content: "" }))).not.toBeNull();
    expect(denial(await runHook("Bash", { command: "git add -A && git commit -m 'x'" }))).not.toBeNull();
    expect(denial(await runHook("Bash", { command: "git -C /w push -u origin issue-1" }))).not.toBeNull();
    expect(denial(await runHook("Bash", { command: "gh pr create --base develop" }))).not.toBeNull();
  });

  it("worktree外・.htmlのWriteと、読み取りのコマンドは通す", async () => {
    expect(denial(await runHook("Write", { file_path: path.join(workDir, "plans/p.md"), content: "" }))).toBeNull();
    expect(denial(await runHook("Write", { file_path: path.join(worktree, "design.html"), content: "" }))).toBeNull();
    expect(denial(await runHook("Bash", { command: "git log --oneline -5; gh issue view 4944" }))).toBeNull();
    expect(denial(await runHook("Read", { file_path: path.join(worktree, "src/a.ts") }))).toBeNull();
  });

  it("計画の承認とアーティファクトの公開が転記にあれば通す", async () => {
    const transcript = writeTranscript("current.jsonl", [...artifactPublished, ...planApproved]);
    expect(denial(await runHook("Edit", { file_path: path.join(worktree, "a.ts") }, { transcript }))).toBeNull();
  });

  it("前の転記で承認した計画も効く（再開・引き継ぎ）", async () => {
    writeTranscript("previous.jsonl", planApproved);
    const transcript = writeTranscript("current.jsonl", []);
    const stdout = await runHook("Bash", { command: "git commit -m x" }, { gates: "plan", transcript });
    expect(denial(stdout)).toBeNull();
  });

  it("却下された計画・公開に失敗したアーティファクトは提示済みにしない", async () => {
    const transcript = writeTranscript("current.jsonl", [
      toolUse("toolu_plan", "ExitPlanMode", {}),
      toolResult("toolu_plan", "The user doesn't want to proceed", true),
      toolUse("toolu_art", "Artifact", { file_path: "/tmp/d.html" }),
      toolResult("toolu_art", "error", true),
    ]);
    const result = denial(await runHook("Edit", { file_path: path.join(worktree, "a.ts") }, { transcript }));
    expect(result.permissionDecisionReason).toContain("21.plan-required");
    expect(result.permissionDecisionReason).toContain("25.artifact-required");
  });

  it("計画だけ承認済みなら、アーティファクトの理由だけで拒否する", async () => {
    const transcript = writeTranscript("current.jsonl", planApproved);
    const result = denial(await runHook("Edit", { file_path: path.join(worktree, "a.ts") }, { transcript }));
    expect(result.permissionDecisionReason).toContain("25.artifact-required");
    expect(result.permissionDecisionReason).not.toContain("計画がまだ承認されていません");
  });

  it("Issueからラベルが外れていれば通す", async () => {
    setIssueLabels(["30.bug"]);
    expect(denial(await runHook("Edit", { file_path: path.join(worktree, "a.ts") }))).toBeNull();
  });

  it("関門の指定が無いセッションには何もしない", async () => {
    expect(denial(await runHook("Edit", { file_path: path.join(worktree, "a.ts") }, { gates: "" }))).toBeNull();
  });
});
