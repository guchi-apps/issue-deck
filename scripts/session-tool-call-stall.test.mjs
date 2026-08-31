// `scripts/lib/session-tool-call-stall.sh`の判定を、転記を一時ディレクトリに作って実行する（#2655）。
//
// 「ツールを呼び出したつもりでテキストに書いただけで、実際には呼ばれていない」ケースの検知は
// `session-resume.test.mjs`と同じくClaude Codeの転記の形に依存する唯一の判定であり、ここを
// 外すと「動いているセッションへ誤って引き上げる」か「止まったまま気づかない」のどちらかになる。

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

const turnDuration = record("system", { subtype: "turn_duration" });
const userText = record("user", { message: { role: "user", content: "進めて" } });

/** Agentツールをテキストとして書いただけで、tool_useとしては呼んでいないassistantレコード。 */
const forkWrittenAsText = record("assistant", {
  message: {
    role: "assistant",
    content: [{ type: "text", text: 'Agent({\n  subagent_type: "fork",\n  prompt: `進めて`\n})' }],
  },
});

/** 同じ内容を実際にtool_useとして呼び出したassistantレコード。 */
const forkActuallyCalled = record("assistant", {
  message: {
    role: "assistant",
    content: [{ type: "tool_use", name: "Agent", input: { subagent_type: "fork" } }],
  },
});

const assistantText = record("assistant", {
  message: { role: "assistant", content: [{ type: "text", text: "できました" }] },
});

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
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-tool-call-stall.sh"))}`,
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
  workDir = mkdtempSync(path.join(tmpdir(), "session-tool-call-stall-"));
  mkdirSync(path.join(workDir, "state"), { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("session_tool_call_stall_transcript_untriggered", () => {
  it("ツール呼び出しをテキストで書いただけ（tool_use無し）なら停滞とみなす", () => {
    const file = writeTranscript([userText, forkWrittenAsText, turnDuration], 0);
    expect(
      runBash(`session_tool_call_stall_transcript_untriggered ${JSON.stringify(file)}`).status,
    ).toBe(0);
  });

  it("実際にtool_useとして呼び出していれば停滞とみなさない", () => {
    const file = writeTranscript([userText, forkActuallyCalled, turnDuration], 0);
    expect(
      runBash(`session_tool_call_stall_transcript_untriggered ${JSON.stringify(file)}`).status,
    ).not.toBe(0);
  });

  it("ツール呼び出し風の記法を含まない普通の応答は停滞とみなさない", () => {
    const file = writeTranscript([userText, assistantText], 0);
    expect(
      runBash(`session_tool_call_stall_transcript_untriggered ${JSON.stringify(file)}`).status,
    ).not.toBe(0);
  });

  it("誤出力の後に人の入力があれば停滞とみなさない（もう誰かが動かしている）", () => {
    const file = writeTranscript([forkWrittenAsText, turnDuration, userText], 0);
    expect(
      runBash(`session_tool_call_stall_transcript_untriggered ${JSON.stringify(file)}`).status,
    ).not.toBe(0);
  });
});

// `session_tool_call_stall_detected`はtmuxセッション名から転記のパスを解決する
// `session_transcript_path`（実物のtmux/`~/.claude/sessions/`に依存）を経由するため、
// `session_resume_interrupted`と同じくここではテストしない。停滞時間の判定は
// `session_resume_stalled_seconds`をそのまま使っており、その境界は`session-resume.test.mjs`が
// 固定している。
