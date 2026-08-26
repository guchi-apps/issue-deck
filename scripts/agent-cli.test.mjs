// `scripts/lib/agent-cli.sh`の解決と引数組み立てを固定する（#2377）。
//
// ここは**どのエージェントCLIをどう起こすかを決める唯一の入口**で、崩れると
// 「`--agent codex`と書いたのにClaude Codeが立つ」か「Codexがネットワークを塞がれたまま立ち、
// `gh`も`git push`も通らない」のどちらかになる。どちらも実機で気づくまで時間がかかるうえ、
// `codex`が入っていないホスト（CI）では起動そのものを試せないため、境界だけを固定しておく。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
