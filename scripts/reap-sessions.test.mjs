// `scripts/reap-sessions.sh`の「worktreeが消えているセッション」の判定（#2422）。
//
// worktreeを先に消したセッションは、以前は期限もリトライも無い`hold`に落ちて**永久に畳まれ
// なかった**。畳んで失われるのは会話の文脈だけ（未コミットの変更も未pushのコミットも置き場ごと
// 消えている）なので、猶予を置いたうえで畳む。ここが`hold`へ戻ると症状は画面から見えず、
// tmuxセッションが1本ずつ積み上がるだけになるため、境界を固定しておく。
//
// 実物のtmux・GitHubは使わない。`tmux`と`gh`をPATHの手前に置いた偽物へ差し替え、状態ファイルの
// 置き場（`ISSUE_DECK_SESSION_STATE_DIR`）だけを渡して1巡ぶん走らせる。
// **`gh`は必ず失敗する偽物にしてある**——移送されたIssueは`gh issue view`が解決できないので、
// この経路がGitHub側を見ないことも同時に確かめる。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/reap-sessions.sh");
const SESSION = "issue-deck-issue-2422";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/**
 * 偽の`tmux`・`gh`と状態ファイルを用意して1巡ぶん実行する。
 * `worktree`を省略すると、存在しないパス（= 消されたworktree）を記述子へ書く。
 */
function run({ idleSeconds, worktree, dryRun = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reap-sessions-test-"));
  tempDirs.push(root);
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const killLog = path.join(root, "kill.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(
    path.join(binDir, "tmux"),
    [
      "#!/usr/bin/env bash",
      "case \"$1\" in",
      `  list-sessions) printf '%s\\n' ${JSON.stringify(SESSION)} ;;`,
      "  list-panes) echo 0 ;;", // 生きているペインが1つ
      `  kill-session) printf '%s\\n' "$*" >>${JSON.stringify(killLog)} ;;`,
      "  *) : ;;",
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  // GitHubは見ない前提を固定する（見に行けば必ず失敗して「残す」側へ落ちる）
  fs.writeFileSync(path.join(binDir, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

  const worktreePath = worktree ?? path.join(root, "worktrees", "issue-2422");
  fs.writeFileSync(
    path.join(stateDir, `${SESSION}.session`),
    [
      `session=${SESSION}`,
      `worktree=${worktreePath}`,
      "repository=guchi-apps/issue-deck",
      "issue=2422",
      "reapable=1",
      "kind=implementation",
      "startedAt=0",
    ].join("\n") + "\n",
  );
  const eventAt = Math.floor(Date.now() / 1000) - idleSeconds;
  fs.writeFileSync(path.join(stateDir, `${SESSION}.event`), `${eventAt} Stop\n`);

  const stdout = execFileSync("bash", [script, ...(dryRun ? ["--dry-run"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      TMUX: "",
      ISSUE_DECK_SESSION_STATE_DIR: stateDir,
    },
  });

  return {
    stdout,
    killed: fs.existsSync(killLog) ? fs.readFileSync(killLog, "utf8") : "",
    reap: fs.existsSync(path.join(stateDir, `${SESSION}.reap`))
      ? fs.readFileSync(path.join(stateDir, `${SESSION}.reap`), "utf8")
      : "",
    descriptorExists: fs.existsSync(path.join(stateDir, `${SESSION}.session`)),
  };
}

describe("reap-sessions.sh: worktreeが消えているセッション（#2422）", () => {
  it("猶予を過ぎていれば畳む", () => {
    const result = run({ idleSeconds: 30 * 60 });
    expect(result.stdout).toContain("セッションを畳みました");
    expect(result.stdout).toContain("worktreeが削除されている");
    expect(result.killed).toContain(`=${SESSION}`);
    // 畳んだセッションの状態ファイルは残さない（次に同じ名前で立つセッションが引き継がないように）
    expect(result.descriptorExists).toBe(false);
  });

  it("猶予の内は畳まず、畳む予定（WORKTREE_GONE）を残す", () => {
    const result = run({ idleSeconds: 10 });
    expect(result.killed).toBe("");
    expect(result.reap).toContain("WORKTREE_GONE");
    expect(result.stdout).toContain("残します");
  });

  it("--dry-runでは畳まず、予定も書かない", () => {
    const result = run({ idleSeconds: 30 * 60, dryRun: true });
    expect(result.stdout).toContain("[dry-run] 畳む対象です");
    expect(result.killed).toBe("");
    expect(result.reap).toBe("");
  });

  it("worktreeが在って状態を確認できないときは、従来どおり残す", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reap-sessions-worktree-"));
    tempDirs.push(root);
    const result = run({ idleSeconds: 30 * 60, worktree: root });
    expect(result.killed).toBe("");
    expect(result.stdout).toContain("worktreeの状態を確認できない");
  });
});
