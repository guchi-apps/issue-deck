// Codexのセッションへ追加指示を差し込む経路を固定する（#2519）。
//
// ここが崩れると「送ったつもりで届いていない」か「Claude Codeのセッションへ`codex queue`を
// 打つ」のどちらかになる。**実物の`codex`はCIに無い**ので、`ISSUE_DECK_CODEX_COMMAND`で
// 差し替えたスタブを相手に、渡す引数と3つの返り値（送った／見送り／送れなかった）を固定する。

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionStateLib = path.join(repoRoot, "scripts/lib/session-state.sh");
const codexQueueLib = path.join(repoRoot, "scripts/lib/codex-queue.sh");

let workDir;

/**
 * `codex`のスタブを置く。呼ばれた引数を1行1つで`argv`へ書き、`exitCode`で終わる。
 * 標準エラーへ`stderr`を出すのは、実物の`Error: No active session found matching …`を模すため。
 */
function writeCodexStub({ exitCode = 0, stderr = "" } = {}) {
  const stub = path.join(workDir, "codex-stub");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > ${JSON.stringify(path.join(workDir, "argv"))}`,
      stderr ? `printf '%s\\n' ${JSON.stringify(stderr)} >&2` : "",
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return stub;
}

/** ライブラリをsourceして`script`を実行し、標準出力と終了コードを返す。 */
function runBash(script, env = {}) {
  const preamble = [
    `source ${JSON.stringify(sessionStateLib)}`,
    `source ${JSON.stringify(codexQueueLib)}`,
  ].join("\n");
  try {
    const stdout = execFileSync("bash", ["-c", `${preamble}\n${script}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        ISSUE_DECK_SESSION_STATE_DIR: path.join(workDir, "state"),
        ...env,
      },
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "" };
  }
}

/** スタブが受け取った引数の配列。呼ばれていなければ`null` */
function stubArgv() {
  const file = path.join(workDir, "argv");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "codex-queue-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const THREAD = "01a0510e-1111-2222-3333-444455556666";

describe("codex_queue_send", () => {
  it("宛先と本文をそのまま codex queue へ渡す", () => {
    const stub = writeCodexStub();
    const { status } = runBash(
      `codex_queue_send ${JSON.stringify(THREAD)} 'CIが失敗しています。直してください。'`,
      { ISSUE_DECK_CODEX_COMMAND: stub },
    );
    expect(status).toBe(0);
    expect(stubArgv()).toEqual([
      "queue",
      "--thread",
      THREAD,
      "--message",
      "CIが失敗しています。直してください。",
    ]);
  });

  // **本文は`--message`の値として1引数で渡す。** 引用に頼らないので、空白や記号が入っても
  // コマンドとして解釈されない
  it("本文に空白や記号が入っても1引数のまま渡す", () => {
    const stub = writeCodexStub();
    const body = "rm -rf / && echo 'x'; $(whoami)";
    // **本文は環境変数で渡す。** ここでJSONの二重引用符へ埋めると、テスト側のbashが
    // `$(whoami)`を展開してしまい、確かめたいこと（値が素通りするか）が測れない
    runBash(`codex_queue_send ${JSON.stringify(THREAD)} "$BODY"`, {
      ISSUE_DECK_CODEX_COMMAND: stub,
      BODY: body,
    });
    expect(stubArgv()?.[4]).toBe(body);
  });

  /**
   * 宛先が無いのは「見送り（1）」。ディレクトリの信頼確認に人が答えれば送れるようになる状態で、
   * **異常ではない**。ここを2（失敗）にすると、画面に赤い失敗として出続ける。
   */
  it("宛先が無ければ見送る（codexを起こさない）", () => {
    const stub = writeCodexStub();
    const { status, stdout } = runBash(`codex_queue_send '' 'つづけて'`, {
      ISSUE_DECK_CODEX_COMMAND: stub,
    });
    expect(status).toBe(1);
    expect(stdout).toContain("宛先");
    expect(stubArgv()).toBeNull();
  });

  it("codexが見つからなければ失敗として返す", () => {
    const { status, stdout } = runBash(`codex_queue_send ${JSON.stringify(THREAD)} 'つづけて'`, {
      ISSUE_DECK_CODEX_COMMAND: path.join(workDir, "no-such-codex"),
    });
    expect(status).toBe(2);
    expect(stdout).toContain("見つからない");
  });

  // 終了済み・存在しないセッションを指したとき（`Error: No active session found matching …`）。
  // **理由の1行をそのまま画面へ運ぶ**ので、出力の最後の行が拾えること
  it("codex queue が失敗したら理由を1行で返す", () => {
    const stub = writeCodexStub({
      exitCode: 1,
      stderr: "Error: No active session found matching '01a0510e'.",
    });
    const { status, stdout } = runBash(`codex_queue_send ${JSON.stringify(THREAD)} 'つづけて'`, {
      ISSUE_DECK_CODEX_COMMAND: stub,
    });
    expect(status).toBe(2);
    expect(stdout).toContain("No active session found matching");
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("応答が無ければ打ち切る", () => {
    const stub = path.join(workDir, "codex-hang");
    writeFileSync(stub, "#!/usr/bin/env bash\nsleep 30\n");
    chmodSync(stub, 0o755);
    const { status, stdout } = runBash(`codex_queue_send ${JSON.stringify(THREAD)} 'つづけて'`, {
      ISSUE_DECK_CODEX_COMMAND: stub,
      ISSUE_DECK_CODEX_QUEUE_TIMEOUT_SECONDS: "1",
    });
    expect(status).toBe(2);
    expect(stdout).toContain("打ち切");
  });
});

describe("session_state（Codexの宛先）", () => {
  it("UUIDの形の値だけを宛先として残す", () => {
    const write = (value) =>
      runBash(`session_state_write_codex_thread 'repo-issue-1' ${JSON.stringify(value)}`).status;
    expect(write(THREAD)).toBe(0);
    expect(runBash(`session_state_read_codex_thread 'repo-issue-1'`).stdout).toBe(THREAD);
    // 形が違う値は書かない（そのまま`--thread`の引数になるため）
    expect(write("not-a-uuid")).toBe(1);
    expect(write("")).toBe(1);
  });

  it("宛先が無ければ読み取りは非0で返る", () => {
    expect(runBash(`session_state_read_codex_thread 'repo-issue-2'`).status).not.toBe(0);
  });

  /**
   * 追加指示の送り方はここで分かれる。**記述子が無い・`agent`が無い・知らない語のときは
   * `claude`へ倒す**（`codex`へ倒すと、Claude Codeのセッションへ宛先の無い`codex queue`を打つ）。
   */
  it("記述子の agent で送り方を決め、迷ったら claude へ倒す", () => {
    expect(runBash(`session_state_agent_kind 'repo-issue-3'`).stdout).toBe("claude");
    runBash(
      `session_state_write_descriptor 'repo-issue-3' '/tmp/w' 'guchi-apps/issue-deck' '3' '1' 'implementation' 'codex'`,
    );
    expect(runBash(`session_state_agent_kind 'repo-issue-3'`).stdout).toBe("codex");
    runBash(
      `session_state_write_descriptor 'repo-issue-4' '/tmp/w' 'guchi-apps/issue-deck' '4' '1' 'implementation'`,
    );
    expect(runBash(`session_state_agent_kind 'repo-issue-4'`).stdout).toBe("claude");
  });

  // 次回の`codex resume`が前の会話を特定できるよう、通常の後始末ではUUIDを残す（#2520）。
  it("セッションの後始末後もresume用の宛先を保持する", () => {
    runBash(`session_state_write_codex_thread 'repo-issue-5' ${JSON.stringify(THREAD)}`);
    runBash(`session_state_remove 'repo-issue-5'`);
    expect(runBash(`session_state_read_codex_thread 'repo-issue-5'`).stdout).toBe(THREAD);
  });

  it("新しい会話で起こすときは前回の宛先を明示的に消せる", () => {
    runBash(`session_state_write_codex_thread 'repo-issue-6' ${JSON.stringify(THREAD)}`);
    runBash(`session_state_clear_codex_thread 'repo-issue-6'`);
    expect(runBash(`session_state_read_codex_thread 'repo-issue-6'`).status).not.toBe(0);
  });
});
