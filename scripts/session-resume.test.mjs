// `scripts/lib/session-resume.sh`の判定を、転記と状態ファイルを一時ディレクトリに作って実行する（#1971）。
//
// APIエラーで打ち切られたturnの検知は、**Claude Codeの転記の形に依存する唯一の判定**であり、
// ここを外すと「動いているセッションへ勝手に送る」か「止まったまま気づかない」のどちらかになる。
// 実物のセッションを立てずに確かめられるのはこの関数までなので、境界だけをここで固定する
// （tmuxへの送出まで含む検証は、`reusable-issue-labels.test.mjs`と違ってCIでは行えない）。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let workDir;

/** 転記の1行（JSONL）。`type`と付加フィールドだけを持つ最小の形。 */
function record(type, extra = {}) {
  return JSON.stringify({ type, ...extra });
}

const apiError = record("assistant", {
  isApiErrorMessage: true,
  message: { role: "assistant", content: [{ type: "text", text: "API Error: 529 Overloaded." }] },
});
const turnDuration = record("system", { subtype: "turn_duration" });
const assistantText = record("assistant", {
  message: { role: "assistant", content: [{ type: "text", text: "できました" }] },
});
const userText = record("user", { message: { role: "user", content: "続けて" } });

/**
 * 転記を書き、最終更新を`ageMinutes`分前にする。
 * 停滞時間はファイルのmtimeで見ているため、ここが検知の入力そのものになる。
 */
function writeTranscript(lines, ageMinutes) {
  const file = path.join(workDir, "transcript.jsonl");
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  const at = new Date(Date.now() - ageMinutes * 60 * 1000);
  utimesSync(file, at, at);
  return file;
}

/** ライブラリをsourceして1行のbashを実行し、標準出力と終了コードを返す。 */
function runBash(script, env = {}) {
  const preamble = [
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-state.sh"))}`,
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-transcript.sh"))}`,
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-resume.sh"))}`,
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

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "session-resume-"));
  mkdirSync(path.join(workDir, "state"), { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("session_resume_transcript_interrupted", () => {
  it("末尾がAPIエラーなら中断とみなす（直後のsystemレコードは飛ばす）", () => {
    const file = writeTranscript([userText, assistantText, apiError, turnDuration], 0);
    expect(runBash(`session_resume_transcript_interrupted ${JSON.stringify(file)}`).status).toBe(0);
  });

  it("普通に応答が終わっていれば中断とみなさない", () => {
    const file = writeTranscript([userText, assistantText], 0);
    expect(runBash(`session_resume_transcript_interrupted ${JSON.stringify(file)}`).status).not.toBe(0);
  });

  it("エラーの後に人の入力があれば中断とみなさない（もう誰かが再開させている）", () => {
    const file = writeTranscript([apiError, turnDuration, userText], 0);
    expect(runBash(`session_resume_transcript_interrupted ${JSON.stringify(file)}`).status).not.toBe(0);
  });
});

describe("session_resume_stalled_seconds", () => {
  it("最終更新からの経過秒数を返す", () => {
    const file = writeTranscript([apiError], 20);
    const { status, stdout } = runBash(`session_resume_stalled_seconds ${JSON.stringify(file)}`);
    expect(status).toBe(0);
    expect(Number(stdout)).toBeGreaterThanOrEqual(20 * 60);
  });

  it("転記が無ければ判定できない（何もしない側へ倒す）", () => {
    expect(runBash(`session_resume_stalled_seconds ${JSON.stringify(path.join(workDir, "none.jsonl"))}`).status).not.toBe(0);
  });
});

describe("再開の回数と間隔", () => {
  const session = "faketest-issue-9999";

  it("記録が無ければ1回目はすぐ送ってよい", () => {
    expect(runBash(`session_resume_due ${session}`).status).toBe(0);
    expect(runBash(`session_resume_exhausted ${session}`).status).not.toBe(0);
  });

  it("送った直後は間隔が空くまで送らない", () => {
    const script = `session_resume_record_attempt ${session}; session_resume_due ${session}`;
    expect(runBash(script).status).not.toBe(0);
  });

  it("間隔が過ぎていれば次を送る", () => {
    const past = Math.floor(Date.now() / 1000) - 30 * 60;
    const script = `session_state_write_resume ${session} ${past} 1 0; session_resume_due ${session}`;
    expect(runBash(script).status).toBe(0);
  });

  it("上限に達したら送らず、人へ渡す段になる", () => {
    const now = Math.floor(Date.now() / 1000);
    const script = `session_state_write_resume ${session} ${now - 3600} 3 0; session_resume_due ${session}`;
    expect(runBash(script).status).not.toBe(0);
    const exhausted = `session_state_write_resume ${session} ${now - 3600} 3 0; session_resume_exhausted ${session}`;
    expect(runBash(exhausted).status).toBe(0);
  });

  it("通知済みの印は1度だけ立つ", () => {
    const now = Math.floor(Date.now() / 1000);
    const script = `session_state_write_resume ${session} ${now} 3 0; session_resume_notified ${session}`;
    expect(runBash(script).status).not.toBe(0);
    const after = `session_state_write_resume ${session} ${now} 3 0; session_resume_record_notified ${session}; session_resume_notified ${session}`;
    expect(runBash(after).status).toBe(0);
  });
});
