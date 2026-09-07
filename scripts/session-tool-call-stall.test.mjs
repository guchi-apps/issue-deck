// `scripts/lib/session-tool-call-stall.sh`の判定を、転記を一時ディレクトリに作って実行する（#2655）。
//
// 「ツールを呼び出したつもりでテキストに書いただけで、実際には呼ばれていない」ケースの検知は
// `session-resume.test.mjs`と同じくClaude Codeの転記の形に依存する唯一の判定であり、ここを
// 外すと「動いているセッションへ誤って引き上げる」か「止まったまま気づかない」のどちらかになる。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

// 自動再送信の回数管理（#2896）。**ここが緩むと、直らないセッションへ固定文面を送り続ける**
// （上限を守れているか）か、逆に1回も送らないまま人へ渡す（`due`が最初から偽）ことになる。
describe("自動再送信の回数管理", () => {
  const session = "issue-deck-issue-2896";

  it("記録が無ければ1回目をすぐ送ってよい", () => {
    expect(runBash(`session_tool_call_stall_read_state ${session}`).stdout).toBe("0 0 0");
    expect(runBash(`session_tool_call_stall_due ${session}`).status).toBe(0);
    expect(runBash(`session_tool_call_stall_exhausted ${session}`).status).not.toBe(0);
  });

  it("送った直後は間隔が空くまで次を送らない", () => {
    runBash(`session_tool_call_stall_record_attempt ${session}`);
    expect(runBash(`session_tool_call_stall_read_state ${session}`).stdout).toMatch(/^\d+ 1 0$/);
    expect(runBash(`session_tool_call_stall_due ${session}`).status).not.toBe(0);
  });

  it("間隔が空けば2回目を送ってよい", () => {
    // 前回の試行を間隔ぶんより前にしておく（`record_attempt`は現在時刻で書くため直接置く）。
    const past = Math.floor(Date.now() / 1000) - 60 * 60;
    runBash(`session_state_write_tool_call_stall ${session} ${past} 1 0`);
    expect(runBash(`session_tool_call_stall_due ${session}`).status).toBe(0);
  });

  it("上限まで送ったら送るのをやめ、人へ渡す段になる", () => {
    const past = Math.floor(Date.now() / 1000) - 60 * 60;
    runBash(`session_state_write_tool_call_stall ${session} ${past} 2 0`);
    expect(runBash(`session_tool_call_stall_due ${session}`).status).not.toBe(0);
    expect(runBash(`session_tool_call_stall_exhausted ${session}`).status).toBe(0);
    expect(runBash(`session_tool_call_stall_notified ${session}`).status).not.toBe(0);
    runBash(`session_tool_call_stall_record_notified ${session}`);
    expect(runBash(`session_tool_call_stall_notified ${session}`).status).toBe(0);
  });

  it("上限を環境変数で変えられる", () => {
    const past = Math.floor(Date.now() / 1000) - 60 * 60;
    runBash(`session_state_write_tool_call_stall ${session} ${past} 2 0`);
    expect(
      runBash(`session_tool_call_stall_due ${session}`, {
        SESSION_TOOL_CALL_STALL_MAX_ATTEMPTS: "3",
      }).status,
    ).toBe(0);
  });

  it("#2896より前の形式（epochだけの1行）は未実施として読む", () => {
    // 入れ替え直後に引き上げ済みだったセッションは、同じ固定文面を1回受け直すだけで済む。
    writeFileSync(path.join(workDir, "state", `${session}.tool-call-stall`), "1757000000\n");
    expect(runBash(`session_tool_call_stall_read_state ${session}`).stdout).toBe("0 0 0");
    expect(runBash(`session_tool_call_stall_due ${session}`).status).toBe(0);
  });

  it("セッションが動き出したら記録を消す", () => {
    runBash(`session_tool_call_stall_record_attempt ${session}`);
    runBash(`session_state_clear_tool_call_stall ${session}`);
    expect(runBash(`session_tool_call_stall_read_state ${session}`).stdout).toBe("0 0 0");
  });
});

// 送る本文は画面（`src/lib/dispatch/session-stall.ts`）と同じ1行でなければならない（#2896）。
// **食い違うと、自動で送ったものと人が押して送ったものの区別が後から付かない。**
describe("SESSION_TOOL_CALL_STALL_BODY", () => {
  it("画面の停滞パネルが送る固定文面と一致する", () => {
    const source = readFileSync(path.join(repoRoot, "src/lib/dispatch/session-stall.ts"), "utf8");
    const match = source.match(/const TOOL_CALL_STALL_BODY\s*=\s*\n?\s*"([^"]+)";/);
    expect(match).not.toBeNull();
    expect(runBash('printf "%s" "$SESSION_TOOL_CALL_STALL_BODY"').stdout).toBe(match[1]);
  });

  it("追加指示として送れる形（1行・500文字以内）である", () => {
    const body = runBash('printf "%s" "$SESSION_TOOL_CALL_STALL_BODY"').stdout;
    expect(body).not.toMatch(/[\n\r]/);
    expect(body.length).toBeLessThanOrEqual(500);
    expect(body.startsWith("/")).toBe(false);
    expect(body.startsWith("!")).toBe(false);
  });
});
