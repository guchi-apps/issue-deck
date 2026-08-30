// Codexのスレッドに`<リポジトリ名> #<Issue番号>`の名前を付ける経路を固定する（#2540）。
//
// ここが崩れると、ChatGPTアプリのセッション一覧が**モデルの自動命名のまま**になり、どれが
// どのIssueのセッションか分からなくなる（Codexにはセッションごとのリンクが無いので、
// 一覧で選べることが「そのIssueのセッションを開く」唯一の手段。#2524・#2537）。
//
// **実物の`codex`はCIに無い**ので、`ISSUE_DECK_CODEX_COMMAND`で差し替えたスタブ（app-serverの
// JSON-RPCを最小限だけ喋る）を相手に、送るリクエストと3つの返り値を固定する。
// 実機（codex-cli 0.151.0）で確かめてあるのは次の3点で、スタブはこれを模している。
//
//   - `initialize` → `initialized` → `thread/name/set`の順で改行区切りJSONを送ると
//     `{"id":2,"result":{}}`が返る
//   - 知らないスレッドIDには`no rollout found for thread id …`のエラーが返る
//   - stdinを閉じるとリクエストを処理せずに終了する（＝応答を読むまで開けておく必要がある）

import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = path.join(repoRoot, "scripts/lib/codex-thread-name.sh");
const sessionStateLib = path.join(repoRoot, "scripts/lib/session-state.sh");
const notifyScript = path.join(repoRoot, "scripts/session-notify.sh");

let workDir;

/**
 * `codex app-server`のスタブ。stdinの行を読み、`initialize`と`thread/name/set`に応える。
 *
 * `mode`で応答を変える。`ok`＝成功、`no-rollout`＝転記がまだ無いエラー、`silent`＝応答しない。
 * 受け取った`thread/name/set`の行は`requests`へ1行ずつ追記する（何回試したかも分かる）。
 */
function writeCodexStub(mode = "ok") {
  const stub = path.join(workDir, "codex-stub");
  const requests = path.join(workDir, "requests");
  const reply =
    mode === "no-rollout"
      ? `'{"error":{"code":-32600,"message":"no rollout found for thread id 01a0"},"id":2}'`
      : `'{"id":2,"result":{}}'`;
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(path.join(workDir, "argv"))}`,
      "while IFS= read -r line; do",
      "  case \"$line\" in",
      `    *'"initialize"'*) echo '{"id":1,"result":{}}' ;;`,
      "    *thread/name/set*)",
      `      printf '%s\\n' "$line" >> ${JSON.stringify(requests)}`,
      mode === "silent" ? "      :" : `      echo ${reply}`,
      "      ;;",
      "  esac",
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return stub;
}

/** スタブが受け取った`thread/name/set`のリクエスト（JSONに直したもの） */
function sentRequests() {
  const file = path.join(workDir, "requests");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** ライブラリをsourceして`script`を実行し、標準出力と終了コードを返す。 */
function runBash(script, env = {}) {
  try {
    const stdout = execFileSync("bash", ["-c", `source ${JSON.stringify(lib)}\n${script}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        // やり直しの待ちでテストを止めない（実機の既定は2秒）
        ISSUE_DECK_CODEX_NAME_RETRY_SECONDS: "0",
        ...env,
      },
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "" };
  }
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "codex-thread-name-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("codex_thread_name_set（#2540）", () => {
  it("app-serverへ thread/name/set を送り、成功したら0で返す", () => {
    const stub = writeCodexStub("ok");
    const result = runBash(
      `codex_thread_name_set "01a05175-4081-7193-ba03-10f922644fea" "issue-deck #2540"; echo "status=$?"`,
      { ISSUE_DECK_CODEX_COMMAND: stub },
    );

    expect(result.stdout).toContain("status=0");
    // **`app-server`を叩く**（`queue`でも`agents`でもない）
    expect(readFileSync(path.join(workDir, "argv"), "utf8").trim()).toBe("app-server");
    expect(sentRequests()).toEqual([
      {
        id: 2,
        method: "thread/name/set",
        params: {
          threadId: "01a05175-4081-7193-ba03-10f922644fea",
          name: "issue-deck #2540",
        },
      },
    ]);
  });

  /**
   * **セッション開始の直後は転記がまだ無いことがある。** `SessionStart`のフックから呼ぶので、
   * 1回目が`no rollout found`でも諦めない（ここを諦めると、起動が遅いホストでだけ名前が
   * 付かなくなり、原因が画面からもログからも分からない）。
   */
  it("転記がまだ無いときはやり直し、それでも駄目なら理由を返す", () => {
    const stub = writeCodexStub("no-rollout");
    const result = runBash(`codex_thread_name_set "01a0" "issue-deck #2540"; echo "status=$?"`, {
      ISSUE_DECK_CODEX_COMMAND: stub,
      ISSUE_DECK_CODEX_NAME_ATTEMPTS: "3",
    });

    expect(sentRequests()).toHaveLength(3);
    expect(result.stdout).toContain("セッションの転記がまだありません");
    expect(result.stdout).toContain("status=2");
  });

  // 応答を待たずに成功と言わない（`codex app-server`はstdinを閉じると処理せずに終了する）
  it("応答が返らないときは失敗として返す", () => {
    const stub = writeCodexStub("silent");
    const result = runBash(`codex_thread_name_set "01a0" "issue-deck #2540"; echo "status=$?"`, {
      ISSUE_DECK_CODEX_COMMAND: stub,
      ISSUE_DECK_CODEX_NAME_READ_SECONDS: "1",
      ISSUE_DECK_CODEX_NAME_ATTEMPTS: "1",
    });

    expect(result.stdout).toContain("応答がありませんでした");
    expect(result.stdout).toContain("status=2");
  });

  // 宛先が無いのは「見送り」。信頼確認に答える前はUUIDが手に入らない（#2519と同じ扱い）
  it("宛先が無ければ見送る（1）", () => {
    const stub = writeCodexStub("ok");
    const result = runBash(`codex_thread_name_set "" "issue-deck #2540"; echo "status=$?"`, {
      ISSUE_DECK_CODEX_COMMAND: stub,
    });

    expect(sentRequests()).toEqual([]);
    expect(result.stdout).toContain("status=1");
  });

  it("codexが無いホストでは失敗として返す（2）", () => {
    const result = runBash(`codex_thread_name_set "01a0" "issue-deck #2540"; echo "status=$?"`, {
      ISSUE_DECK_CODEX_COMMAND: path.join(workDir, "no-such-codex"),
    });

    expect(result.stdout).toContain("見つからない");
    expect(result.stdout).toContain("status=2");
  });

  // JSONを壊さない（名前は`<リポジトリ名> #<番号>`だが、呼び出し元が変わっても壊れないこと）
  it("引用符を含む名前でもJSONとして送れる", () => {
    const stub = writeCodexStub("ok");
    runBash(`codex_thread_name_set "01a0" 'issue-"deck" #1'`, {
      ISSUE_DECK_CODEX_COMMAND: stub,
    });

    expect(sentRequests()[0].params.name).toBe('issue-"deck" #1');
  });
});

/**
 * `session-notify.sh`の`SessionStart`から呼ばれることを固定する。
 *
 * **名前を付けるのはCodexのセッションだけ。** Claude Codeのセッションで`codex app-server`を
 * 起こすと、そのホストで動く全セッションの開始が少しずつ遅くなる（しかも付ける相手がいない）。
 */
describe("session-notify.sh の SessionStart（#2540）", () => {
  /** セッションの記述子を置く（`agent`でエージェントを見分けている） */
  function writeDescriptor(agent) {
    execFileSync(
      "bash",
      [
        "-c",
        `source ${JSON.stringify(sessionStateLib)}\n` +
          `session_state_write_descriptor "issue-deck-issue-2540" "/tmp/wt" "guchi-apps/issue-deck" "2540" "1" "implementation" "${agent}"`,
      ],
      { env: { ...process.env, ISSUE_DECK_SESSION_STATE_DIR: path.join(workDir, "state") } },
    );
  }

  function runSessionStart(stub) {
    const child = execFile(
      "bash",
      [notifyScript, "2540", "issue-deck", "guchi-apps/issue-deck"],
      {
        encoding: "utf8",
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: workDir,
          TMUX: "",
          SESSION_NOTIFY_TMUX_SESSION: "issue-deck-issue-2540",
          ISSUE_DECK_SESSION_STATE_DIR: path.join(workDir, "state"),
          ISSUE_DECK_NOTIFY_ENV: path.join(workDir, "notify.env"),
          ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "dispatch.env"),
          ISSUE_DECK_CODEX_COMMAND: stub,
          ISSUE_DECK_CODEX_NAME_ATTEMPTS: "1",
        },
      },
    );
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "01a05175-4081-7193-ba03-10f922644fea",
        source: "startup",
      }),
    );
    return done;
  }

  /** 名前を付ける処理は切り離して走るので、届くまで少し待つ */
  async function waitForRequests(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (sentRequests().length > 0) return sentRequests();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return sentRequests();
  }

  beforeEach(() => {
    writeFileSync(path.join(workDir, "notify.env"), "");
    writeFileSync(path.join(workDir, "dispatch.env"), "");
  });

  it("Codexのセッションには <リポジトリ名> #<Issue番号> を付ける", async () => {
    const stub = writeCodexStub("ok");
    writeDescriptor("codex");

    await runSessionStart(stub);
    const requests = await waitForRequests();

    expect(requests).toHaveLength(1);
    expect(requests[0].params).toEqual({
      threadId: "01a05175-4081-7193-ba03-10f922644fea",
      // Claude Codeの`--name`（`run-issue-session.sh`の`SESSION_NAME`）と同じ文字列
      name: "issue-deck #2540",
    });
  });

  it("Claude Codeのセッションでは何もしない", async () => {
    const stub = writeCodexStub("ok");
    writeDescriptor("claude");

    await runSessionStart(stub);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(sentRequests()).toEqual([]);
  });
});
