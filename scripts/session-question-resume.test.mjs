// 横断質問セッション（`kind=question`）を畳んだ後に同じ会話へ戻す仕組み（#3033）を固定する。
//
// 質問セッションのcwdは質問Issueごとではなくリポジトリごとに固定されている（#1529）ため、
// `claude --continue`（そのcwdで最後に動いた会話）だと別の質問の会話を拾う（#1648）。そこで
//
//   1. `SessionStart`フックが、質問セッションに限り、tmuxセッション名（質問Issueごとに一定）を
//      キーにsessionIdをホストへ控える
//   2. `run-issue-session.sh`が、質問セッションでは`--continue`を使わず、控えたIDと履歴の
//      `<id>.jsonl`が揃うときだけ`--resume <id>`を渡す（無ければ新しい会話・古いIDは消す）
//
// 守っているのは「別の質問の会話へ戻らないこと」と「実装セッションの`--continue`を変えないこと」。
// 実物のClaude Codeとtmuxは使えないので、引数を出力するだけの偽の`claude`と、セッション名を返す
// だけの偽の`tmux`をPATHの先頭へ置く。

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const notifyScript = path.join(repoRoot, "scripts/session-notify.sh");
const runScript = path.join(repoRoot, "scripts/run-issue-session.sh");
const stateLib = path.join(repoRoot, "scripts/lib/session-state.sh");

const SESSION = "question-issue-69";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_ID = "99999999-2222-3333-4444-555555555555";

let workDir;
let stateDir;
let cwdDir;
let binDir;
let historyDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "session-question-resume-"));
  stateDir = path.join(workDir, "state");
  cwdDir = path.join(workDir, "cwd");
  binDir = path.join(workDir, "bin");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(path.join(binDir, "claude"), '#!/usr/bin/env bash\necho "FAKE-CLAUDE-ARGS: $*"\n', {
    mode: 0o755,
  });
  writeFileSync(
    path.join(binDir, "tmux"),
    `#!/usr/bin/env bash\nif [[ "$1" == "display-message" ]]; then echo "${SESSION}"; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(workDir, "prompt.md"), "prompt\n");
  writeFileSync(path.join(workDir, "dispatch.env"), "");
  writeFileSync(path.join(workDir, "notify.env"), "");

  // Claude Codeの会話履歴の置き場（cwdのパスの英数字以外を`-`へ置き換えた名前）
  historyDir = path.join(workDir, ".claude/projects", cwdDir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(historyDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function idFile() {
  return path.join(stateDir, `${SESSION}.claude-session`);
}

/** 記述子（`kind`・`agent`）を置く。書くのは本物のランチャーと同じ関数。 */
function writeDescriptor({ kind, agent = "claude" }) {
  execFileSync(
    "bash",
    [
      "-c",
      `source "${stateLib}"; session_state_write_descriptor "${SESSION}" "${cwdDir}" "guchi-apps/question" 69 1 "${kind}" "${agent}"`,
    ],
    { env: { PATH: process.env.PATH, HOME: workDir, ISSUE_DECK_SESSION_STATE_DIR: stateDir } },
  );
}

function runHook(hookJson) {
  const child = execFile("bash", [notifyScript, "69", "question", "guchi-apps/question"], {
    encoding: "utf8",
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: workDir,
      TMUX: "",
      SESSION_NOTIFY_TMUX_SESSION: SESSION,
      ISSUE_DECK_SESSION_STATE_DIR: stateDir,
      ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "dispatch.env"),
      ISSUE_DECK_NOTIFY_ENV: path.join(workDir, "notify.env"),
    },
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  child.stdin.end(JSON.stringify(hookJson));
  return done;
}

/** ランチャーを走らせ、偽の`claude`が受け取った引数の行を返す。 */
function runLauncher({ kind }) {
  const output = execFileSync("bash", [runScript, "69", "0", path.join(workDir, "prompt.md")], {
    cwd: cwdDir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: workDir,
      TMUX: "/fake",
      ISSUE_DECK_DEV_SERVER: "0",
      ISSUE_DECK_REPO_SLUG: "guchi-apps/question",
      ISSUE_DECK_SESSION_KIND: kind,
      ISSUE_DECK_WORKTREE_BASE: path.join(workDir, "wt"),
      ISSUE_DECK_SESSION_STATE_DIR: stateDir,
    },
  });
  return output.split("\n").find((line) => line.startsWith("FAKE-CLAUDE-ARGS:")) ?? "";
}

describe("SessionStart フックが控えるsessionId", () => {
  it("横断質問セッション（Claude Code）では、tmuxセッション名をキーに控える", async () => {
    writeDescriptor({ kind: "question" });
    await runHook({ hook_event_name: "SessionStart", session_id: SESSION_ID });
    expect(readFileSync(idFile(), "utf8").trim()).toBe(SESSION_ID);
  });

  // 実装セッションは worktree ごとに `--continue` で戻せるので、ファイルを増やす理由が無い
  it("実装セッションでは控えない", async () => {
    writeDescriptor({ kind: "implementation" });
    await runHook({ hook_event_name: "SessionStart", session_id: SESSION_ID });
    expect(existsSync(idFile())).toBe(false);
  });

  it("Codexの質問セッションでは控えない（宛先は別の`.codex-thread`）", async () => {
    writeDescriptor({ kind: "question", agent: "codex" });
    await runHook({ hook_event_name: "SessionStart", session_id: SESSION_ID });
    expect(existsSync(idFile())).toBe(false);
  });

  it("UUIDの形でない値は控えない（そのまま`--resume`の引数になるため）", async () => {
    writeDescriptor({ kind: "question" });
    await runHook({ hook_event_name: "SessionStart", session_id: "not-a-uuid" });
    expect(existsSync(idFile())).toBe(false);
  });
});

describe("run-issue-session.sh の再開", () => {
  // `runLauncher`は`run-issue-session.sh`を丸ごとサブプロセスとして起動する重いテストで、
  // CIのフルスイート実行（並列ワーカー＋7000件超）の終盤では既定の5秒を超えて時々タイムアウトする
  // （#3277のCIで発生）。実処理は1秒未満で終わるので、ロジックではなく既定タイムアウトの余裕不足が
  // 原因と判断し、`scripts/heavy-command.test.mjs`と同じ形でサブプロセス起動テストへ個別の
  // タイムアウトを設定する。
  it(
    "質問セッションは、控えたIDと履歴が揃えば`--resume <id>`で戻る（`--continue`は使わない）",
    { timeout: 20000 },
    () => {
      writeFileSync(idFile(), `${SESSION_ID}\n`);
      writeFileSync(path.join(historyDir, `${SESSION_ID}.jsonl`), "");
      // 同じcwdの別の質問の会話。`--continue`ならこちらを拾いうる
      writeFileSync(path.join(historyDir, `${OTHER_ID}.jsonl`), "");

      const args = runLauncher({ kind: "question" });
      expect(args).toContain(`--resume ${SESSION_ID}`);
      expect(args).not.toContain("--continue");
      expect(args).toContain("前回の会話の続きです");
      // cwdがgitリポジトリではないので、質問Issueを`--repo`で明示する。追い質問への回答向けの言い方にする
      expect(args).toContain("gh issue view 69 --repo guchi-apps/question --comments");
      expect(args).toContain("追い質問");
      // 終了後（`cleanup`）も控えを消さない。消すと畳んだ後の復旧が毎回新しい会話になる
      expect(existsSync(idFile())).toBe(true);
    },
  );

  it(
    "控えが無ければ、同じcwdに別の会話があっても新しい会話で始める",
    { timeout: 20000 },
    () => {
      writeFileSync(path.join(historyDir, `${OTHER_ID}.jsonl`), "");

      const args = runLauncher({ kind: "question" });
      expect(args).not.toContain("--resume");
      expect(args).not.toContain("--continue");
      expect(args).not.toContain("前回の会話の続きです");
    },
  );

  it(
    "控えた会話の履歴が消えていれば新しい会話で始め、古いIDも消す",
    { timeout: 20000 },
    () => {
      writeFileSync(idFile(), `${SESSION_ID}\n`);

      const args = runLauncher({ kind: "question" });
      expect(args).not.toContain("--resume");
      expect(existsSync(idFile())).toBe(false);
    },
  );

  it(
    "実装セッションは従来どおり`--continue`で戻る",
    { timeout: 20000 },
    () => {
      writeFileSync(path.join(historyDir, `${OTHER_ID}.jsonl`), "");

      const args = runLauncher({ kind: "implementation" });
      expect(args).toContain("--continue");
      expect(args).not.toContain("--resume");
    },
  );
});
