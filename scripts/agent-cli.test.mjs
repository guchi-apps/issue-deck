// `scripts/lib/agent-cli.sh`の解決と引数組み立てを固定する（#2377）。
//
// ここは**どのエージェントCLIをどう起こすかを決める唯一の入口**で、崩れると
// 「`--agent codex`と書いたのにClaude Codeが立つ」か「Codexがネットワークを塞がれたまま立ち、
// `gh`も`git push`も通らない」のどちらかになる。どちらも実機で気づくまで時間がかかるうえ、
// `codex`が入っていないホスト（CI）では起動そのものを試せないため、境界だけを固定しておく。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libPath = path.join(repoRoot, "scripts/lib/agent-cli.sh");

/** `agent-cli.sh`をsourceしたうえで`script`を実行し、標準出力と終了コードを返す */
function run(script, env) {
  const body = [`source ${JSON.stringify(libPath)}`, script].join("\n");
  try {
    const stdout = execFileSync("bash", ["-c", body], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return { stdout, status: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? "", status: error.status ?? 1 };
  }
}

/** 種別を解決して、解決結果・実行ファイル名・表示名を1行ずつ返す */
function resolve(raw) {
  const { stdout, status } = run(
    [
      `agent_cli_resolve_kind ${JSON.stringify(raw)} || exit 1`,
      `printf '%s\\n%s\\n%s\\n' "$AGENT_CLI_KIND" "$(agent_cli_command_name "$AGENT_CLI_KIND")" "$(agent_cli_display_name "$AGENT_CLI_KIND")"`,
    ].join("\n"),
  );
  const [kind, command, displayName] = stdout.split("\n");
  return { kind: kind ?? "", command: command ?? "", displayName: displayName ?? "", status };
}

/**
 * Codexの起動引数を組み立てて、1引数1行で返す。
 *
 * **`workspace`の既定はgitリポジトリでないディレクトリ**。`--add-dir`（#2529）は
 * ワークスペースの外にgitの管理領域があるときだけ付くため、ここを省くと**このテスト自身を
 * 走らせているworktree**の本体`.git`が混ざり、実行場所で結果が変わる。
 */
function codexArgs(env = {}, resumeThread = "", workspace = os.tmpdir()) {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const { stdout } = run(
    [
      exports,
      `agent_cli_build_codex_args ${JSON.stringify(resumeThread)} ${JSON.stringify(workspace)}`,
      `printf '%s\\n' "\${AGENT_CLI_ARGS[@]}"`,
    ].join("\n"),
  );
  return stdout.split("\n").filter((line) => line !== "");
}

describe("agent_cli_resolve_kind", () => {
  it("指定が無ければ Claude Code のまま", () => {
    expect(resolve("")).toMatchObject({ kind: "claude", command: "claude", displayName: "Claude Code" });
  });

  it("codex を指定すると codex を起こす", () => {
    expect(resolve("codex")).toMatchObject({ kind: "codex", command: "codex", displayName: "Codex CLI" });
  });

  it("大文字で書いても同じ", () => {
    expect(resolve("Codex").kind).toBe("codex");
  });

  // **黙ってClaudeへ落とさない。** 指定したつもりで別のエージェントが立つほうが厄介なので、
  // 未対応の値はその場で失敗させる。
  it("未対応の値は失敗する", () => {
    const { status, kind } = resolve("gemini");
    expect(status).not.toBe(0);
    expect(kind).toBe("");
  });
});

describe("agent_cli_build_codex_args", () => {
  it("既定は workspace-write ＋ 承認なし ＋ ネットワーク許可", () => {
    expect(codexArgs()).toEqual([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "-c",
      "sandbox_workspace_write.network_access=true",
    ]);
  });

  // ネットワークの許可は`workspace-write`のときだけ意味を持つ設定なので、他のモードでは付けない。
  it("サンドボックスを変えるとネットワークの上書きは付かない", () => {
    expect(codexArgs({ ISSUE_DECK_CODEX_SANDBOX: "danger-full-access" })).toEqual([
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
    ]);
  });

  it("モデルを指定すると -m が付く", () => {
    expect(codexArgs({ ISSUE_DECK_CODEX_MODEL: "gpt-5-codex" }).slice(-2)).toEqual(["-m", "gpt-5-codex"]);
  });

  it("逃げ道の追加引数は末尾に付く", () => {
    expect(codexArgs({ ISSUE_DECK_CODEX_EXTRA_ARGS: "--search --no-alt-screen" }).slice(-2)).toEqual([
      "--search",
      "--no-alt-screen",
    ]);
  });

  it("UUIDがあればピッカーを出さない resume サブコマンドを先頭へ付ける", () => {
    expect(codexArgs({}, "01a0510e-1234-4abc-8def-0123456789ab").slice(0, 4)).toEqual([
      "resume",
      "01a0510e-1234-4abc-8def-0123456789ab",
      "--sandbox",
      "workspace-write",
    ]);
  });
});

// `agent_cli_codex_writable_dirs`（#2529）。
//
// ここで一番効くのは「**開けすぎないこと**」。`--add-dir`はサンドボックスの閉じ込めを緩める
// フラグで、`--ask-for-approval never`で走らせている前提の裏付けそのものを削る。逆に足りないと
// git worktreeでは`git add`が`index.lock: Read-only file system`で落ち、実装が終わっていても
// コミットできない（#2511で実際に止まった）。**ふつうのクローンでは1つも足さない**ことと、
// **worktreeでは本体の`.git`だけを足す**ことの両方を固定する。
describe("agent_cli_codex_writable_dirs", () => {
  const tmpDirs = [];

  function git(cwd, ...args) {
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
      cwd,
      stdio: "ignore",
    });
  }

  /** 本体のクローンと、そこから生やしたlinked worktreeを作る */
  function makeRepoWithWorktree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-git-"));
    tmpDirs.push(root);
    const main = path.join(root, "main");
    const worktree = path.join(root, "wt");
    fs.mkdirSync(main, { recursive: true });
    git(main, "init", "--initial-branch=develop", ".");
    fs.writeFileSync(path.join(main, "README.md"), "x\n");
    git(main, "add", "README.md");
    git(main, "commit", "-m", "初期化");
    git(main, "worktree", "add", "-b", "issue-1", worktree);
    return { main, worktree };
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    }
  });

  function writableDirs(workspace) {
    const { stdout } = run(`agent_cli_codex_writable_dirs ${JSON.stringify(workspace)}`);
    return stdout.split("\n").filter((line) => line !== "");
  }

  it("ふつうのクローンでは何も出さない（`.git`がワークスペースの中にあるため）", () => {
    expect(writableDirs(makeRepoWithWorktree().main)).toEqual([]);
  });

  // linked worktreeの管理領域（`…/.git/worktrees/<名前>`）は本体の`.git`の下にあるので重ねない。
  it("worktreeでは本体の`.git`だけを出す", () => {
    const { main, worktree } = makeRepoWithWorktree();
    expect(writableDirs(worktree)).toEqual([fs.realpathSync(path.join(main, ".git"))]);
  });

  it("gitリポジトリでないディレクトリでは何も出さない", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-plain-"));
    tmpDirs.push(dir);
    expect(writableDirs(dir)).toEqual([]);
  });

  // 起動直前に呼ばれるので、ここで非0を返すと`set -euo pipefail`の呼び出し元ごと止まる。
  it("存在しないディレクトリを渡しても何も出さない", () => {
    expect(writableDirs(path.join(os.tmpdir(), "agent-cli-no-such-dir"))).toEqual([]);
  });
});

describe("agent_cli_build_codex_args の --add-dir", () => {
  const tmpDirs = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    }
  });

  function makeWorktree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-args-"));
    tmpDirs.push(root);
    const main = path.join(root, "main");
    const worktree = path.join(root, "wt");
    fs.mkdirSync(main, { recursive: true });
    const git = (...args) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
        cwd: main,
        stdio: "ignore",
      });
    git("init", "--initial-branch=develop", ".");
    fs.writeFileSync(path.join(main, "README.md"), "x\n");
    git("add", "README.md");
    git("commit", "-m", "初期化");
    git("worktree", "add", "-b", "issue-1", worktree);
    return { gitDir: fs.realpathSync(path.join(main, ".git")), worktree };
  }

  it("workspace-writeのworktreeでは本体の`.git`を開ける", () => {
    const { gitDir, worktree } = makeWorktree();
    expect(codexArgs({}, "", worktree)).toEqual([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--add-dir",
      gitDir,
    ]);
  });

  // `read-only`は書けないのが目的、`danger-full-access`は元から全部書ける。どちらも足す意味がない。
  it("workspace-write以外では付けない", () => {
    const { worktree } = makeWorktree();
    expect(codexArgs({ ISSUE_DECK_CODEX_SANDBOX: "read-only" }, "", worktree)).toEqual([
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
    ]);
    expect(codexArgs({ ISSUE_DECK_CODEX_SANDBOX: "danger-full-access" }, "", worktree)).not.toContain("--add-dir");
  });

  it("モデル指定と逃げ道の追加引数は`--add-dir`より後ろに並ぶ", () => {
    const { worktree } = makeWorktree();
    const args = codexArgs({ ISSUE_DECK_CODEX_MODEL: "gpt-5-codex", ISSUE_DECK_CODEX_EXTRA_ARGS: "--search" }, "", worktree);
    expect(args.slice(-3)).toEqual(["-m", "gpt-5-codex", "--search"]);
    expect(args.indexOf("--add-dir")).toBeLessThan(args.indexOf("-m"));
  });
});

/** Codexのフック引数を組み立てて、1引数1行で返す（終了コードも返す） */
function codexHookArgs(commandLine) {
  const { stdout, status } = run(
    [
      `agent_cli_build_codex_hook_args ${JSON.stringify(commandLine)} || exit 1`,
      `printf '%s\\n' "\${AGENT_CLI_HOOK_ARGS[@]}"`,
    ].join("\n"),
  );
  return { args: stdout.split("\n").filter((line) => line !== ""), status };
}

describe("agent_cli_build_codex_hook_args", () => {
  // 繋ぐのは`SessionStart`と`Stop`だけ（#2509）。`PostToolUse`はCodexでは必ず捨てられるので
  // 繋がない——増やすとツール実行のたびにプロセスが起きる。
  it("SessionStart と Stop を、フックの信頼を越えるフラグ付きで繋ぐ", () => {
    const { args, status } = codexHookArgs("'/x/session-notify.sh' '12' 'repo' 'owner/repo'");
    expect(status).toBe(0);
    expect(args).toEqual([
      "--dangerously-bypass-hook-trust",
      "-c",
      `hooks.SessionStart=[{hooks=[{type="command",command="'/x/session-notify.sh' '12' 'repo' 'owner/repo'"}]}]`,
      "-c",
      `hooks.Stop=[{hooks=[{type="command",command="'/x/session-notify.sh' '12' 'repo' 'owner/repo'"}]}]`,
    ]);
  });

  // TOMLの基本文字列に入れるので、`"`と`\`だけは潰しておく。ここが崩れると
  // Codexの設定パースが落ち、**フックどころか起動そのものが失敗する**。
  it("コマンド行の二重引用符とバックスラッシュはエスケープする", () => {
    const { args } = codexHookArgs('a"b\\c');
    expect(args[2]).toBe(`hooks.SessionStart=[{hooks=[{type="command",command="a\\"b\\\\c"}]}]`);
  });

  it("コマンド行が空なら何も組み立てない", () => {
    const { args, status } = codexHookArgs("");
    expect(status).not.toBe(0);
    expect(args).toEqual([]);
  });
});

describe("agent_cli_codex_project_hook_file", () => {
  const tmpDirs = [];

  function makeDir(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-hook-"));
    tmpDirs.push(dir);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    }
  });

  function detect(dir) {
    return run(`agent_cli_codex_project_hook_file ${JSON.stringify(dir)} || exit 1`);
  }

  it("プロジェクト層のフック設定が無ければ検出しない", () => {
    expect(detect(makeDir()).status).not.toBe(0);
  });

  // ここで検出されたworktreeでは、呼び出し側がフックを丸ごと有効にしない（#2509）。
  // `--dangerously-bypass-hook-trust`はプロセス単位のフラグで、付けるとリポジトリ同梱の
  // フックまでレビュー無しで走るため。
  it("`.codex/hooks.json`があれば検出する", () => {
    const dir = makeDir({ ".codex/hooks.json": "{}" });
    expect(detect(dir)).toMatchObject({ stdout: path.join(dir, ".codex/hooks.json"), status: 0 });
  });

  // `[hooks]`はconfig.toml側にも書けるので、中身は見ずに存在だけで降りる（安全側）。
  it("`.codex/config.toml`があれば検出する", () => {
    const dir = makeDir({ ".codex/config.toml": "model = \"x\"\n" });
    expect(detect(dir)).toMatchObject({ stdout: path.join(dir, ".codex/config.toml"), status: 0 });
  });
});

// `agent_cli_codex_sandbox_probe`（#2526）。
//
// ここが崩れると、**画面でCodexを選べるのにセッションが即死する**（`codex`コマンドは入って
// いるのにbubblewrapがサンドボックスを組み立てられないホストがある。subpcで実際に起きた）か、
// 逆に**動くホストでCodexを選べなくなる**かのどちらかになる。実機のカーネル設定に依存する
// 判定なので、`codex`を偽物に差し替えて境界だけを固定する。
describe("agent_cli_codex_sandbox_probe", () => {
  const tmpDirs = [];

  /** `codex`として振る舞うスクリプトを置いた PATH 用のディレクトリを作る */
  function makeCodexBin(script) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-codex-"));
    tmpDirs.push(dir);
    if (script !== null) {
      const target = path.join(dir, "codex");
      fs.writeFileSync(target, script);
      fs.chmodSync(target, 0o755);
    }
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    }
  });

  /** 偽の`codex`だけが見えるPATHで下見して、判定と材料の行を返す */
  function probe(script, env = {}) {
    const dir = makeCodexBin(script);
    const { stdout } = run(
      [
        `probe="$(agent_cli_codex_sandbox_probe)"`,
        `printf '%s\\n%s\\n' "$(agent_cli_codex_sandbox_probe_state "$probe")" "$(agent_cli_codex_sandbox_probe_reason "$probe")"`,
      ].join("\n"),
      { PATH: `${dir}:/usr/bin:/bin`, ...env },
    );
    const [state, reason] = stdout.split("\n");
    return { state: state ?? "", reason: reason ?? "" };
  }

  it("`codex`が無ければ unknown（判定材料が無いので塞がない）", () => {
    expect(probe(null).state).toBe("unknown");
  });

  // `codex sandbox`を持たない版では確かめようがない。ここを`broken`にすると、動くかもしれない
  // ホストでCodexを選べなくなる。**証拠があるときだけ塞ぐ。**
  it("`codex sandbox`を持たない版なら unknown", () => {
    expect(probe("#!/bin/bash\nexit 1\n").state).toBe("unknown");
  });

  it("サンドボックスを組み立てられれば ok", () => {
    expect(probe("#!/bin/bash\nexit 0\n")).toEqual({ state: "ok", reason: "" });
  });

  // 材料として返すのは最初の非空行だけ。この1行がそのまま「ホストのuserns制限」の目印になる。
  it("組み立てに失敗すれば broken と、エラーの最初の行を返す", () => {
    const script = [
      "#!/bin/bash",
      'if [[ "$2" == "--help" ]]; then exit 0; fi',
      "echo >&2",
      "echo 'bwrap: setting up uid map: Permission denied' >&2",
      "echo '2行目は捨てる' >&2",
      "exit 1",
    ].join("\n");
    expect(probe(script)).toEqual({
      state: "broken",
      reason: "bwrap: setting up uid map: Permission denied",
    });
  });

  // 下見と起動で違うモードを見ていると、「下見は通ったのに起動で落ちる」が起きる。
  // `codex sandbox`は`--sandbox`を受け取らないので`-c sandbox_mode=`で渡す。
  it("起動と同じサンドボックスのモードで下見する", () => {
    const script = ['#!/bin/bash', 'if [[ "$2" == "--help" ]]; then exit 0; fi', 'echo "$*" >&2', "exit 1"].join("\n");
    expect(probe(script).reason).toBe(
      "sandbox -c sandbox_mode=workspace-write -c sandbox_workspace_write.network_access=true -- /bin/true",
    );
    expect(probe(script, { ISSUE_DECK_CODEX_SANDBOX: "danger-full-access" }).reason).toBe(
      "sandbox -c sandbox_mode=danger-full-access -- /bin/true",
    );
  });

  // TUIへの引数をここへ持ち込むと、下見だけが不正な引数で落ちて`broken`になる。
  it("`ISSUE_DECK_CODEX_EXTRA_ARGS`は下見に持ち込まない", () => {
    const script = ['#!/bin/bash', 'if [[ "$2" == "--help" ]]; then exit 0; fi', 'echo "$*" >&2', "exit 1"].join("\n");
    expect(probe(script, { ISSUE_DECK_CODEX_EXTRA_ARGS: "--search" }).reason).not.toContain("--search");
  });
});
