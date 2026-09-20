// `scripts/lib/session-codex-turn-stall.sh`の判定を、Codexの転記と状態ファイルを一時ディレクトリに
// 作って実行する（#3174）。
//
// Codexのターンが閉じないまま止まったことの検知は、**Codexの転記の形に依存する唯一の判定**で、
// ここを外すと「動いているセッションへ勝手に送る」か「止まったまま気づかない」のどちらかになる。
// `session-resume.test.mjs`（APIエラー）と同じ立場で、境界だけをここで固定する。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SESSION = "repo-issue-3174";
const THREAD = "11111111-2222-3333-4444-555555555555";

let workDir;

/** Codexの転記の1行（JSONL）。実物と同じく`type`と`payload.type`を持つ。 */
function record(type, payload) {
  return JSON.stringify({ timestamp: "2026-09-20T05:00:00.000Z", type, payload });
}

const taskStarted = record("event_msg", { type: "task_started", model_context_window: 272000 });
const taskComplete = record("event_msg", {
  type: "task_complete",
  turn_id: "turn-1",
  last_agent_message: "できました",
});
const turnAborted = record("event_msg", {
  type: "turn_aborted",
  turn_id: "turn-1",
  reason: "interrupted",
});
const toolCall = record("response_item", { type: "custom_tool_call", name: "shell" });
const toolOutput = record("response_item", { type: "custom_tool_call_output", output: "ok" });

/**
 * 転記を書き、最終更新を`ageMinutes`分前にする。
 * 停滞時間はファイルのmtimeで見ているため、ここが検知の入力そのものになる。
 */
function writeTranscript(lines, ageMinutes) {
  const dir = path.join(workDir, "codex-sessions", "2026", "09", "20");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-20T05-00-00-${THREAD}.jsonl`);
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  const at = new Date(Date.now() - ageMinutes * 60 * 1000);
  utimesSync(file, at, at);
  return file;
}

/** ライブラリをsourceして1行のbashを実行し、標準出力と終了コードを返す。 */
function runBash(script, env = {}) {
  const preamble = [
    "session-state.sh",
    "session-transcript.sh",
    "session-resume.sh",
    "session-codex-turn-stall.sh",
  ]
    .map((name) => `source ${JSON.stringify(path.join(repoRoot, "scripts/lib", name))}`)
    .join("\n");
  try {
    const stdout = execFileSync("bash", ["-c", `${preamble}\n${script}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        ISSUE_DECK_SESSION_STATE_DIR: path.join(workDir, "state"),
        CODEX_SESSIONS_DIR: path.join(workDir, "codex-sessions"),
        ...env,
      },
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "" };
  }
}

/** `session_codex_turn_stall_detected`が引けるよう、Codexのセッションとして記述子を置く。 */
function registerCodexSession(agent = "codex") {
  return [
    `session_state_write_descriptor ${SESSION} /tmp repo 3174 false implementation ${agent}`,
    `session_state_write_codex_thread ${SESSION} ${THREAD}`,
  ].join("; ");
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "codex-turn-stall-"));
  mkdirSync(path.join(workDir, "state"), { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("session_codex_turn_stall_transcript_unfinished", () => {
  it("task_startedのまま閉じていなければ、ターンが終わっていないとみなす", () => {
    const file = writeTranscript([taskStarted, toolCall, toolOutput], 0);
    const script = `session_codex_turn_stall_transcript_unfinished ${JSON.stringify(file)}`;
    expect(runBash(script).status).toBe(0);
  });

  it("task_completeで閉じていれば、ターンが終わったとみなす", () => {
    const file = writeTranscript([taskStarted, toolCall, taskComplete], 0);
    const script = `session_codex_turn_stall_transcript_unfinished ${JSON.stringify(file)}`;
    expect(runBash(script).status).not.toBe(0);
  });

  it("turn_abortedで閉じていれば、ターンが終わったとみなす（Ctrl-Cでの中断）", () => {
    const file = writeTranscript([taskStarted, turnAborted], 0);
    const script = `session_codex_turn_stall_transcript_unfinished ${JSON.stringify(file)}`;
    expect(runBash(script).status).not.toBe(0);
  });

  it("閉じたあとに次のターンが始まっていれば、また終わっていないとみなす", () => {
    const file = writeTranscript([taskStarted, taskComplete, taskStarted], 0);
    const script = `session_codex_turn_stall_transcript_unfinished ${JSON.stringify(file)}`;
    expect(runBash(script).status).toBe(0);
  });

  it("ターンのマーカーが1つも無ければ、判定しない", () => {
    const file = writeTranscript([toolCall, toolOutput], 0);
    const script = `session_codex_turn_stall_transcript_unfinished ${JSON.stringify(file)}`;
    expect(runBash(script).status).not.toBe(0);
  });

  it("ツールの出力に同じ文字列が混ざっていても拾わない（event_msgだけを見る）", () => {
    // `response_item`の中身は**モデルとツールが書いた任意のテキスト**なので、ここを拾うと
    // 「転記を読ませているセッション」が自分で検知を起こせてしまう。
    const disguised = record("response_item", {
      type: "custom_tool_call_output",
      output: '{"type":"task_started"}',
    });
    const file = writeTranscript([taskStarted, taskComplete, disguised], 0);
    const script = `session_codex_turn_stall_transcript_unfinished ${JSON.stringify(file)}`;
    expect(runBash(script).status).not.toBe(0);
  });
});

describe("session_codex_turn_stall_detected", () => {
  it("閾値を超えて更新が止まっていれば停滞とみなす", () => {
    writeTranscript([taskStarted, toolCall], 30);
    expect(runBash(`${registerCodexSession()}; session_codex_turn_stall_detected ${SESSION}`).status).toBe(0);
  });

  it("まだ閾値に達していなければ停滞とみなさない（長いツール実行を横取りしない）", () => {
    // 実測ではターン内のレコード間隔は最大103秒で、既定10分に届くものは無かった（#3174）。
    writeTranscript([taskStarted, toolCall], 2);
    expect(
      runBash(`${registerCodexSession()}; session_codex_turn_stall_detected ${SESSION}`).status,
    ).not.toBe(0);
  });

  it("ターンが閉じていれば、いくら止まっていても停滞とみなさない（入力待ち）", () => {
    writeTranscript([taskStarted, taskComplete], 120);
    expect(
      runBash(`${registerCodexSession()}; session_codex_turn_stall_detected ${SESSION}`).status,
    ).not.toBe(0);
  });

  it("Claude Codeのセッションでは判定しない", () => {
    writeTranscript([taskStarted, toolCall], 30);
    expect(
      runBash(`${registerCodexSession("claude")}; session_codex_turn_stall_detected ${SESSION}`).status,
    ).not.toBe(0);
  });
});

describe("session_codex_turn_stall_settled", () => {
  it("ターンが閉じていれば記録を消してよい", () => {
    writeTranscript([taskStarted, taskComplete], 30);
    expect(runBash(`${registerCodexSession()}; session_codex_turn_stall_settled ${SESSION}`).status).toBe(0);
  });

  it("ターンが閉じていなければ、停滞時間に関わらず記録を残す", () => {
    // **ここが「検知しなくなったら消す」との違い。** 送った直後は停滞時間が閾値未満になるが、
    // ターンは閉じていないので記録は残り、上限が効き続ける。
    writeTranscript([taskStarted, toolCall], 0);
    expect(
      runBash(`${registerCodexSession()}; session_codex_turn_stall_settled ${SESSION}`).status,
    ).not.toBe(0);
  });
});

describe("回数の管理", () => {
  it("記録が無ければ0回目として扱い、1回目はすぐ送れる", () => {
    const script = `${registerCodexSession()}; session_codex_turn_stall_read_state ${SESSION}`;
    expect(runBash(script).stdout).toBe("0 0 0");
    expect(runBash(`${registerCodexSession()}; session_codex_turn_stall_due ${SESSION}`).status).toBe(0);
  });

  it("2回目は間隔が空くまで送らない", () => {
    const setup = `${registerCodexSession()}; session_codex_turn_stall_record_attempt ${SESSION}`;
    expect(runBash(`${setup}; session_codex_turn_stall_due ${SESSION}`).status).not.toBe(0);
    expect(
      runBash(`${setup}; session_codex_turn_stall_due ${SESSION}`, {
        SESSION_CODEX_TURN_STALL_INTERVAL_MINUTES: "0",
      }).status,
    ).toBe(0);
  });

  it("上限まで試したら送らず、人へ渡す段になる", () => {
    const setup = [
      registerCodexSession(),
      `session_state_write_codex_turn_stall ${SESSION} 0 3 0`,
    ].join("; ");
    expect(runBash(`${setup}; session_codex_turn_stall_due ${SESSION}`).status).not.toBe(0);
    expect(runBash(`${setup}; session_codex_turn_stall_exhausted ${SESSION}`).status).toBe(0);
    expect(runBash(`${setup}; session_codex_turn_stall_notified ${SESSION}`).status).not.toBe(0);
    expect(
      runBash(`${setup}; session_codex_turn_stall_record_notified ${SESSION}; session_codex_turn_stall_notified ${SESSION}`)
        .status,
    ).toBe(0);
  });

  it("消すと0回目へ戻る", () => {
    const setup = [
      registerCodexSession(),
      `session_state_write_codex_turn_stall ${SESSION} 0 3 1`,
      `session_state_clear_codex_turn_stall ${SESSION}`,
    ].join("; ");
    expect(runBash(`${setup}; session_codex_turn_stall_read_state ${SESSION}`).stdout).toBe("0 0 0");
  });
});

// 送る本文は画面（`src/lib/dispatch/session-stall.ts`）と同じ1行でなければならない。
// **食い違うと、自動で送ったものと人が押して送ったものの区別が後から付かない。**
describe("SESSION_CODEX_TURN_STALL_BODY", () => {
  it("画面の停滞パネルが送る固定文面と一致する", () => {
    const source = readFileSync(path.join(repoRoot, "src/lib/dispatch/session-stall.ts"), "utf8");
    const match = source.match(/const TURN_STALL_BODY\s*=\s*\n?\s*"([^"]+)";/);
    expect(match).not.toBeNull();
    expect(runBash('printf "%s" "$SESSION_CODEX_TURN_STALL_BODY"').stdout).toBe(match[1]);
  });

  it("引き上げコメントに載せる文面とも一致する", () => {
    // 人はIssueコメントのコードブロックを写して送ることがある（#2886より前の唯一の経路）。
    const source = readFileSync(path.join(repoRoot, "src/lib/dispatch/session-escalation.ts"), "utf8");
    const body = runBash('printf "%s" "$SESSION_CODEX_TURN_STALL_BODY"').stdout;
    expect(source).toContain(body);
  });

  it("1行・制御文字なし・500文字以内で、先頭がスラッシュや!ではない", () => {
    // `deliver_session_instruction`が最後に確かめる条件と同じ（外すと毎回見送られる）。
    const body = runBash('printf "%s" "$SESSION_CODEX_TURN_STALL_BODY"').stdout;
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(500);
    expect(body).not.toMatch(/[\n\r\u0000-\u001f]/);
    expect(body.startsWith("/")).toBe(false);
    expect(body.startsWith("!")).toBe(false);
  });
});
