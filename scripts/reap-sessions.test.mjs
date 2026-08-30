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

// ---------------------------------------------------------------------------
// `11.local`をどの経路で見るか（#2474）
//
// 引き渡し時に`11.local`を外し忘れたセッションは、以前は期限もリトライも無い`hold`に落ちて
// **PRがマージされても永久に残った**。畳む経路も猶予も決まらないので`.reap`が書かれず、画面に
// 自動終了の残り時間も出ない。CLOSED・マージ済みの2経路では`11.local`を見ないようにしたが、
// 引き渡し済みの経路（HANDOFF_*）は「`11.local`を外した＝もう作業しない」という宣言を前提に
// 判定しているため、そちらでは従来どおり見る。この線引きが戻ると症状は画面から見えないので、
// 境界を固定しておく。
// ---------------------------------------------------------------------------

const GH_SESSION = "issue-deck-issue-2474";
const GH_ISSUE = 2474;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd, args) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...GIT_ENV } });
}

/**
 * cleanでpush済みのworktree（条件7を通る状態）と、応答内容を指定できる偽の`gh`を用意して
 * 1巡ぶん実行する。
 *
 * - `issueState` … `gh issue view`が返すIssueの状態（`OPEN` / `CLOSED`）
 * - `labels` … 同じく返すラベル名の配列
 * - `mergedPr` / `openPr` … `gh pr list --state merged` / `--state open`が返すPR番号（空で無し）
 * - `repository` … 状態ファイルに書くリポジトリ（手動PRの一覧に載っているかで挙動が変わる。#2499）
 * - `pushedToBaseBranch` … HEADを`issue-<番号>`以外のリモートブランチにも載せるか
 *   （＝このセッションのコミットが手元に残っていない状態。`HANDOFF_NO_PR`の前提）
 */
function runGh({
  idleSeconds,
  issueState = "OPEN",
  labels = [],
  mergedPr = "",
  openPr = "",
  repository = "guchi-apps/issue-deck",
  pushedToBaseBranch = false,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reap-sessions-label-"));
  tempDirs.push(root);
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const killLog = path.join(root, "kill.log");
  const worktree = path.join(root, "worktree");
  const origin = path.join(root, "origin.git");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });

  // 実物のgitは使う（`status --porcelain`と`branch -r --contains HEAD`の挙動を偽装しない）。
  git(root, ["init", "--bare", "--initial-branch=develop", origin]);
  git(worktree, ["init", "--initial-branch=develop"]);
  fs.writeFileSync(path.join(worktree, "README.md"), "test\n");
  git(worktree, ["add", "README.md"]);
  git(worktree, ["commit", "-m", "test"]);
  git(worktree, ["remote", "add", "origin", origin]);
  git(worktree, ["push", "origin", `HEAD:refs/heads/issue-${GH_ISSUE}`]);
  if (pushedToBaseBranch) git(worktree, ["push", "origin", "HEAD:refs/heads/develop"]);
  git(worktree, ["fetch", "origin"]);

  fs.writeFileSync(
    path.join(binDir, "tmux"),
    [
      "#!/usr/bin/env bash",
      'case "$1" in',
      `  list-sessions) printf '%s\\n' ${JSON.stringify(GH_SESSION)} ;;`,
      "  list-panes) echo 0 ;;",
      `  kill-session) printf '%s\\n' "$*" >>${JSON.stringify(killLog)} ;;`,
      "  *) : ;;",
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "gh"),
    [
      "#!/usr/bin/env bash",
      'args="$*"',
      'if [[ "$1" == "issue" ]]; then',
      `  printf '%s\\n' ${[issueState, ...labels].map((line) => JSON.stringify(line)).join(" ")}`,
      "  exit 0",
      "fi",
      'case "$args" in',
      `  *"--state merged"*) printf '%s' ${JSON.stringify(mergedPr)} ;;`,
      `  *"--state open"*) printf '%s' ${JSON.stringify(openPr)} ;;`,
      "esac",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    path.join(stateDir, `${GH_SESSION}.session`),
    [
      `session=${GH_SESSION}`,
      `worktree=${worktree}`,
      `repository=${repository}`,
      `issue=${GH_ISSUE}`,
      "reapable=1",
      "kind=implementation",
      "startedAt=0",
    ].join("\n") + "\n",
  );
  const eventAt = Math.floor(Date.now() / 1000) - idleSeconds;
  fs.writeFileSync(path.join(stateDir, `${GH_SESSION}.event`), `${eventAt} Stop\n`);

  const stdout = execFileSync("bash", [script], {
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
    reap: fs.existsSync(path.join(stateDir, `${GH_SESSION}.reap`))
      ? fs.readFileSync(path.join(stateDir, `${GH_SESSION}.reap`), "utf8")
      : "",
  };
}

describe("reap-sessions.sh: 11.local を見る経路（#2474）", () => {
  it("11.local が付いていても、PRがマージ済みなら畳む", () => {
    const result = runGh({ idleSeconds: 30 * 60, labels: ["11.local", "70.confirm"], mergedPr: "470" });
    expect(result.stdout).toContain("セッションを畳みました");
    expect(result.stdout).toContain("PR #470 がマージ済み");
    expect(result.killed).toContain(`=${GH_SESSION}`);
  });

  it("11.local が付いていても、IssueがCLOSEDなら畳む", () => {
    const result = runGh({ idleSeconds: 30 * 60, issueState: "CLOSED", labels: ["11.local"] });
    expect(result.stdout).toContain("セッションを畳みました");
    expect(result.stdout).toContain(`Issue #${GH_ISSUE} はCLOSED`);
    expect(result.killed).toContain(`=${GH_SESSION}`);
  });

  it("11.local が付いたマージ済みでも、猶予の内は畳む予定（PR_MERGED）を残す", () => {
    // ここが`.reap`を書けるようになったことが#2474の主眼（画面の「あと◯分で自動終了」）
    const result = runGh({ idleSeconds: 10, labels: ["11.local"], mergedPr: "470" });
    expect(result.killed).toBe("");
    expect(result.reap).toContain("PR_MERGED");
  });

  it("引き渡し済みの経路では、11.local が付いている間は残す", () => {
    const result = runGh({ idleSeconds: 30 * 60, labels: ["11.local"], openPr: "480" });
    expect(result.killed).toBe("");
    expect(result.stdout).toContain("11.local が付いている");
    // 畳む経路が決まらないので終了予告も書かない（残り時間を出せる状態ではない）
    expect(result.reap).toBe("");
  });

  it("11.local が外れていれば、従来どおり引き渡し済みの経路で畳む", () => {
    const result = runGh({ idleSeconds: 30 * 60, openPr: "480" });
    expect(result.stdout).toContain("セッションを畳みました");
    expect(result.stdout).toContain("PR #480 を作成しレビューへ引き渡し済み");
    expect(result.killed).toContain(`=${GH_SESSION}`);
  });
});

// #2499: 一覧（scripts/local-repo-pr-policy.conf）は実物を読む。写しを作ると、
// 実物へ足したリポジトリがテストでは従来どおり畳まれるという最悪のずれ方をする。
describe("reap-sessions.sh: PRを人の指示で作るリポジトリ（#2499）", () => {
  it("PRが無ければ、コミットが本流へ入っていても畳まない", () => {
    const result = runGh({
      idleSeconds: 30 * 60,
      repository: "guchi-apps/ideas",
      pushedToBaseBranch: true,
    });
    expect(result.killed).toBe("");
    expect(result.stdout).toContain("PRを人の指示で作るリポジトリで");
    // 指示を出せばまだ続けられるので、画面に「まもなく終了」を出さない
    expect(result.reap).toBe("");
  });

  it("一覧に無いリポジトリなら、従来どおりPR無しでも畳む", () => {
    const result = runGh({ idleSeconds: 30 * 60, pushedToBaseBranch: true });
    expect(result.stdout).toContain("セッションを畳みました");
    expect(result.stdout).toContain("PRを作らずにローカル作業を終えている");
    expect(result.killed).toContain(`=${GH_SESSION}`);
  });

  it("PRができていれば、一覧に載っていても従来どおり畳む", () => {
    const result = runGh({
      idleSeconds: 30 * 60,
      repository: "guchi-apps/ideas",
      pushedToBaseBranch: true,
      openPr: "12",
    });
    expect(result.stdout).toContain("セッションを畳みました");
    expect(result.stdout).toContain("PR #12 を作成しレビューへ引き渡し済み");
    expect(result.killed).toContain(`=${GH_SESSION}`);
  });
});
