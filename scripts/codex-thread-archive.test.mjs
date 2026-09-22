// 終わったCodexセッションをChatGPTアプリのリモート一覧から外す経路を固定する（#3357）。
//
// ここが崩れると、一覧が「過去のIssueのセッション」で埋まるか（アーカイブされない）、
// 逆に**動いているセッションや人が直接始めた会話まで消える**（アーカイブしすぎる）。
// `codex resume`の前に戻し損ねると、前回の会話を引き継げなくなる。
//
// **実物の`codex`はCIに無い**ので、送る実体（`ISSUE_DECK_CODEX_RPC_COMMAND`）と
// `codex app-server`（`ISSUE_DECK_CODEX_COMMAND`）をスタブへ差し替える。スタブが模している
// 実機（codex-cli 0.152.1）の応答は次の3つ。
//
//   - アーカイブできた → `{"id":2,"result":{}}`
//   - アーカイブ済み・転記が無い → `no rollout found for thread id …`
//   - 別のプロセスが書き手を握っている → `thread … already has an active writer`

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionStateLib = path.join(repoRoot, "scripts/lib/session-state.sh");
const archiveLib = path.join(repoRoot, "scripts/lib/codex-thread-archive.sh");
const rpcScript = path.join(repoRoot, "scripts/lib/codex-app-server-rpc.py");

const THREAD_A = "01a0c6f1-9091-7b51-9b22-0c4d49cb19d0";
const THREAD_B = "01a05386-ee36-7b53-806e-3e2f965afe66";
const THREAD_C = "01a0c63b-cf80-7a40-a125-f5fe5ffa37f7";

let workDir;
let stateDir;

/**
 * 送る実体のスタブ。受け取った`<method> <params>`を`calls`へ1行ずつ書き、
 * `codes`（スレッドUUID→終了コード）で返す。既定は0。
 */
function writeRpcStub(codes = {}) {
  const stub = path.join(workDir, "rpc-stub");
  const cases = Object.entries(codes)
    .map(([thread, code]) => `  *${thread}*) echo "stub ${code}"; exit ${code} ;;`)
    .join("\n");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf '%s %s\\n' "$1" "$2" >> ${JSON.stringify(path.join(workDir, "calls"))}`,
      'case "$2" in',
      cases,
      "esac",
      'echo ok',
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return stub;
}

function calls() {
  const file = path.join(workDir, "calls");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function writeThread(session, thread) {
  writeFileSync(path.join(stateDir, `${session}.codex-thread`), `${thread}\n`);
}

function runBash(script, env = {}) {
  try {
    const stdout = execFileSync(
      "bash",
      ["-c", `source ${JSON.stringify(sessionStateLib)}\nsource ${JSON.stringify(archiveLib)}\n${script}`],
      {
        encoding: "utf8",
        env: { ...process.env, ISSUE_DECK_SESSION_STATE_DIR: stateDir, ...env },
      },
    );
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "" };
  }
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "codex-thread-archive-"));
  stateDir = path.join(workDir, "sessions");
  mkdirSync(stateDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("codex_thread_archive_ended", () => {
  it("動いているセッションは残し、終わったセッションだけをアーカイブして印を付ける", () => {
    writeThread("repo-issue-1", THREAD_A);
    writeThread("repo-issue-2", THREAD_B);
    const rpc = writeRpcStub();

    const result = runBash(`codex_thread_archive_ended repo-issue-2`, { ISSUE_DECK_CODEX_RPC_COMMAND: rpc });

    expect(result.status).toBe(0);
    expect(calls()).toEqual([`thread/archive {"threadId":"${THREAD_A}"}`]);
    expect(result.stdout).toContain("1件アーカイブしました");
    expect(readFileSync(path.join(stateDir, "repo-issue-1.codex-archived"), "utf8")).toBe(`${THREAD_A}\n`);
    expect(existsSync(path.join(stateDir, "repo-issue-2.codex-archived"))).toBe(false);
  });

  it("印の付いたスレッドには2回目を送らない", () => {
    writeThread("repo-issue-1", THREAD_A);
    const rpc = writeRpcStub();
    runBash(`codex_thread_archive_ended`, { ISSUE_DECK_CODEX_RPC_COMMAND: rpc });
    runBash(`codex_thread_archive_ended`, { ISSUE_DECK_CODEX_RPC_COMMAND: rpc });

    expect(calls()).toHaveLength(1);
  });

  it("同じセッション名で新しい会話が始まったら、新しいUUIDは改めてアーカイブする", () => {
    writeThread("repo-issue-1", THREAD_A);
    const rpc = writeRpcStub();
    runBash(`codex_thread_archive_ended`, { ISSUE_DECK_CODEX_RPC_COMMAND: rpc });
    writeThread("repo-issue-1", THREAD_C);
    runBash(`codex_thread_archive_ended`, { ISSUE_DECK_CODEX_RPC_COMMAND: rpc });

    expect(calls()).toEqual([
      `thread/archive {"threadId":"${THREAD_A}"}`,
      `thread/archive {"threadId":"${THREAD_C}"}`,
    ]);
  });

  it("転記が無い（3）は済んだ扱い、書き手がいる（4）と失敗（2）は次の巡で見直す", () => {
    writeThread("repo-issue-1", THREAD_A);
    writeThread("repo-issue-2", THREAD_B);
    writeThread("repo-issue-3", THREAD_C);
    const rpc = writeRpcStub({ [THREAD_A]: 3, [THREAD_B]: 4, [THREAD_C]: 2 });

    const result = runBash(`codex_thread_archive_ended`, { ISSUE_DECK_CODEX_RPC_COMMAND: rpc });

    expect(result.status).toBe(0);
    expect(existsSync(path.join(stateDir, "repo-issue-1.codex-archived"))).toBe(true);
    expect(existsSync(path.join(stateDir, "repo-issue-2.codex-archived"))).toBe(false);
    expect(existsSync(path.join(stateDir, "repo-issue-3.codex-archived"))).toBe(false);
    expect(result.stdout).toContain("repo-issue-2: まだ動いているため");
    expect(result.stdout).toContain("repo-issue-3: アーカイブできませんでした");
    // 3は「隠すものが無い」だけで、アーカイブした件数には数えない
    expect(result.stdout).not.toContain("件アーカイブしました");
  });

  it("ISSUE_DECK_CODEX_ARCHIVE_ENDED=0 では何も送らない", () => {
    writeThread("repo-issue-1", THREAD_A);
    const rpc = writeRpcStub();
    runBash(`codex_thread_archive_ended`, {
      ISSUE_DECK_CODEX_RPC_COMMAND: rpc,
      ISSUE_DECK_CODEX_ARCHIVE_ENDED: "0",
    });

    expect(calls()).toEqual([]);
  });
});

describe("codex_thread_unarchive_for_resume", () => {
  it("アーカイブ済みの印があるときだけ戻し、印を消す", () => {
    writeThread("repo-issue-1", THREAD_A);
    writeFileSync(path.join(stateDir, "repo-issue-1.codex-archived"), `${THREAD_A}\n`);
    const rpc = writeRpcStub();

    const result = runBash(`codex_thread_unarchive_for_resume repo-issue-1 ${THREAD_A}`, {
      ISSUE_DECK_CODEX_RPC_COMMAND: rpc,
    });

    expect(result.status).toBe(0);
    expect(calls()).toEqual([`thread/unarchive {"threadId":"${THREAD_A}"}`]);
    expect(existsSync(path.join(stateDir, "repo-issue-1.codex-archived"))).toBe(false);
  });

  it("印が無ければ何も送らない", () => {
    const rpc = writeRpcStub();
    const result = runBash(`codex_thread_unarchive_for_resume repo-issue-1 ${THREAD_A}`, {
      ISSUE_DECK_CODEX_RPC_COMMAND: rpc,
    });

    expect(result.status).toBe(0);
    expect(calls()).toEqual([]);
  });

  it("戻せなければ非0で理由を返し、印は残す", () => {
    writeFileSync(path.join(stateDir, "repo-issue-1.codex-archived"), `${THREAD_A}\n`);
    const rpc = writeRpcStub({ [THREAD_A]: 2 });
    const result = runBash(`codex_thread_unarchive_for_resume repo-issue-1 ${THREAD_A}`, {
      ISSUE_DECK_CODEX_RPC_COMMAND: rpc,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("stub 2");
    expect(existsSync(path.join(stateDir, "repo-issue-1.codex-archived"))).toBe(true);
  });
});

describe("session_state_clear_codex_thread", () => {
  it("新しい会話で起こすときは、アーカイブ済みの印も一緒に消す", () => {
    writeThread("repo-issue-1", THREAD_A);
    writeFileSync(path.join(stateDir, "repo-issue-1.codex-archived"), `${THREAD_A}\n`);
    runBash(`session_state_clear_codex_thread repo-issue-1`);

    expect(existsSync(path.join(stateDir, "repo-issue-1.codex-thread"))).toBe(false);
    expect(existsSync(path.join(stateDir, "repo-issue-1.codex-archived"))).toBe(false);
  });
});

describe("codex-app-server-rpc.py（stdio）", () => {
  /** `codex app-server`のスタブ。`thread/archive`に`reply`で応える */
  function writeAppServerStub(reply) {
    const stub = path.join(workDir, "codex-stub");
    writeFileSync(
      stub,
      [
        "#!/usr/bin/env bash",
        "while IFS= read -r line; do",
        '  case "$line" in',
        `    *'"initialize"'*) echo '{"id":1,"result":{}}' ;;`,
        `    *thread/archive*) echo '${reply}' ;;`,
        "  esac",
        "done",
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    return stub;
  }

  function runRpc(reply) {
    const env = {
      ...process.env,
      ISSUE_DECK_CODEX_COMMAND: writeAppServerStub(reply),
      // デーモンのソケットが無い状態＝stdioへ落ちる経路
      ISSUE_DECK_CODEX_APP_SERVER_SOCKET: path.join(workDir, "no-such.sock"),
      ISSUE_DECK_CODEX_RPC_TIMEOUT_SECONDS: "5",
    };
    try {
      const stdout = execFileSync("python3", [rpcScript, "thread/archive", `{"threadId":"${THREAD_A}"}`], {
        encoding: "utf8",
        env,
      });
      return { status: 0, stdout };
    } catch (error) {
      return { status: error.status ?? 1, stdout: error.stdout ?? "" };
    }
  }

  it("成功は0", () => {
    expect(runRpc('{"id":2,"result":{}}')).toEqual({ status: 0, stdout: "ok\n" });
  });

  it("転記が無いは3", () => {
    const result = runRpc('{"id":2,"error":{"code":-32600,"message":"no rollout found for thread id x"}}');
    expect(result.status).toBe(3);
  });

  it("書き手がいるは4", () => {
    const result = runRpc('{"id":2,"error":{"code":-32600,"message":"thread x already has an active writer"}}');
    expect(result.status).toBe(4);
  });

  it("それ以外の失敗は2で、理由を1行返す", () => {
    const result = runRpc('{"id":2,"error":{"code":-32601,"message":"method not found"}}');
    expect(result).toEqual({ status: 2, stdout: "method not found\n" });
  });
});

describe("codex_remote_control_keepalive", () => {
  function setup({ enabled = true, pid = null } = {}) {
    const home = path.join(workDir, "codex-home");
    mkdirSync(path.join(home, "app-server-daemon"), { recursive: true });
    writeFileSync(
      path.join(home, "app-server-daemon/settings.json"),
      JSON.stringify({ remoteControlEnabled: enabled }),
    );
    if (pid !== null) {
      writeFileSync(path.join(home, "app-server-daemon/app-server.pid"), JSON.stringify({ pid }));
    }
    const codex = path.join(workDir, "codex");
    writeFileSync(
      codex,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(path.join(workDir, "codex-argv"))}\n`,
    );
    chmodSync(codex, 0o755);
    return {
      codex,
      env: {
        CODEX_HOME: home,
        ISSUE_DECK_CODEX_REMOTE_KEEPALIVE_STAMP: path.join(workDir, "keepalive.stamp"),
      },
    };
  }

  /** 切り離して起こすので、呼ばれたかどうかは少し待って確かめる */
  function codexArgv() {
    const file = path.join(workDir, "codex-argv");
    for (let i = 0; i < 50 && !existsSync(file); i++) execFileSync("sleep", ["0.05"]);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  }

  it("有効にしたホストでデーモンが止まっていれば remote-control start を打つ", () => {
    const { codex, env } = setup();
    const result = runBash(`codex_remote_control_keepalive ${JSON.stringify(codex)}`, env);

    expect(result.stdout).toContain("起こし直します");
    expect(codexArgv()).toEqual(["remote-control start --json"]);
  });

  it("一度も有効にしていないホストでは起こさない", () => {
    const { codex, env } = setup({ enabled: false });
    const result = runBash(`codex_remote_control_keepalive ${JSON.stringify(codex)}`, env);

    expect(result.stdout).toBe("");
  });

  it("間隔の内側では打ち直さない", () => {
    const { codex, env } = setup();
    runBash(`codex_remote_control_keepalive ${JSON.stringify(codex)}`, env);
    const second = runBash(`codex_remote_control_keepalive ${JSON.stringify(codex)}`, env);

    expect(second.stdout).toBe("");
  });

  it("デーモンのpidが生きていてソケットがあれば何もしない", () => {
    const { codex, env } = setup({ pid: process.pid });
    const socketPath = path.join(workDir, "fake.sock");
    // ソケットの実体を作る（`-S`で判定するため、通常ファイルでは代わりにならない）
    execFileSync("python3", ["-c", `import socket;s=socket.socket(socket.AF_UNIX);s.bind(${JSON.stringify(socketPath)})`]);
    const result = runBash(`codex_remote_control_keepalive ${JSON.stringify(codex)}`, {
      ...env,
      ISSUE_DECK_CODEX_APP_SERVER_SOCKET: socketPath,
    });

    expect(result.stdout).toBe("");
  });
});
