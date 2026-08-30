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
function run(script) {
  const body = [`source ${JSON.stringify(libPath)}`, script].join("\n");
  try {
    const stdout = execFileSync("bash", ["-c", body], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

/** Codexの起動引数を組み立てて、1引数1行で返す */
function codexArgs(env = {}) {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const { stdout } = run([exports, `agent_cli_build_codex_args`, `printf '%s\\n' "\${AGENT_CLI_ARGS[@]}"`].join("\n"));
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
