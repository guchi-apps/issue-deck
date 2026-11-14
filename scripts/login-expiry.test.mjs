// `scripts/lib/login-expiry.sh`の判定を、転記と資格情報ファイルを一時ディレクトリに作って実行する（#5320）。
//
// ログイン切れの検知は、Claude Codeの転記の形（`authentication_failed`）と資格情報ファイルの
// 更新時刻に依存する。外すと「切れているのに起動し続ける」か「直ったのに起動が止まり続ける」になる。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let workDir;

const record = (type, extra = {}) => JSON.stringify({ type, ...extra });
const loginError = record("assistant", {
  isApiErrorMessage: true,
  error: "authentication_failed",
  message: { role: "assistant", content: [{ type: "text", text: "Login reached its time limit · Please run /login" }] },
});
const apiError = record("assistant", {
  isApiErrorMessage: true,
  message: { role: "assistant", content: [{ type: "text", text: "API Error: 529 Overloaded." }] },
});
const turnDuration = record("system", { subtype: "turn_duration" });
const assistantText = record("assistant", { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });

function ago(file, seconds) {
  const at = new Date(Date.now() - seconds * 1000);
  utimesSync(file, at, at);
}

function writeTranscript(lines, ageSeconds) {
  const file = path.join(workDir, "transcript.jsonl");
  writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  ago(file, ageSeconds);
  return file;
}

function writeCredentials(ageSeconds) {
  const file = path.join(workDir, "credentials.json");
  writeFileSync(file, "{}");
  ago(file, ageSeconds);
}

function runBash(script) {
  const preamble = [
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-state.sh"))}`,
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-transcript.sh"))}`,
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-resume.sh"))}`,
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/login-expiry.sh"))}`,
    // 転記の場所の解決は検証の対象外。固定のファイルを返す
    `session_transcript_path() { printf '%s' "$FAKE_TRANSCRIPT"; }`,
  ].join("\n");
  try {
    const stdout = execFileSync("bash", ["-c", `${preamble}\n${script}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        ISSUE_DECK_SESSION_STATE_DIR: path.join(workDir, "state", "sessions"),
        CLAUDE_CREDENTIALS_FILE: path.join(workDir, "credentials.json"),
        LOGIN_EXPIRY_STATE_FILE: path.join(workDir, "state", "login-expired"),
        FAKE_TRANSCRIPT: path.join(workDir, "transcript.jsonl"),
      },
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "" };
  }
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "login-expiry-"));
  mkdirSync(path.join(workDir, "state", "sessions"), { recursive: true });
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("login_expiry_transcript_auth_failed", () => {
  it("末尾が authentication_failed のエラーなら検知する", () => {
    const f = writeTranscript([assistantText, loginError, turnDuration], 120);
    expect(runBash(`login_expiry_transcript_auth_failed ${f}`).status).toBe(0);
  });
  it("APIの一時エラー（529）はログイン切れとみなさない", () => {
    const f = writeTranscript([assistantText, apiError, turnDuration], 120);
    expect(runBash(`login_expiry_transcript_auth_failed ${f}`).status).not.toBe(0);
  });
  it("エラーの後に会話が続いていれば検知しない", () => {
    const f = writeTranscript([loginError, assistantText], 120);
    expect(runBash(`login_expiry_transcript_auth_failed ${f}`).status).not.toBe(0);
  });
});

describe("login_expiry_session_expired", () => {
  it("資格情報より新しいエラーは切れている", () => {
    writeCredentials(3600);
    writeTranscript([loginError], 120);
    expect(runBash("login_expiry_session_expired s-issue-1").status).toBe(0);
  });
  it("資格情報（/login）より古いエラーは数えない", () => {
    writeTranscript([loginError], 3600);
    writeCredentials(60);
    expect(runBash("login_expiry_session_expired s-issue-1").status).not.toBe(0);
  });
  it("書いている最中（直後）は見送る", () => {
    writeCredentials(3600);
    writeTranscript([loginError], 1);
    expect(runBash("login_expiry_session_expired s-issue-1").status).not.toBe(0);
  });
});

describe("自動再開との分離", () => {
  it("ログイン切れは session_resume_transcript_interrupted の対象外", () => {
    const f = writeTranscript([loginError, turnDuration], 3600);
    expect(runBash(`session_resume_transcript_interrupted ${f}`).status).not.toBe(0);
  });
  it("APIエラーは従来どおり対象", () => {
    const f = writeTranscript([apiError, turnDuration], 3600);
    expect(runBash(`session_resume_transcript_interrupted ${f}`).status).toBe(0);
  });
});

describe("通知済みの印", () => {
  it("記録・確認・解除ができる", () => {
    const r = runBash(
      `login_expiry_notified && echo before; login_expiry_record_notified; login_expiry_notified && echo during; login_expiry_clear; login_expiry_notified && echo after`,
    );
    expect(r.stdout.trim().split("\n")).toEqual(["during"]);
  });
});
