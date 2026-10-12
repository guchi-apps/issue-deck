// 計画ファイルを書いたまま`ExitPlanMode`を呼ばずに応答を終えたセッション（#4562）の扱いを固定する。
//
// #4496では「計画ファイルを書き終えました。次の応答で承認を依頼します。」で応答を終え、疑問符が
// 無いため`question_asked`（#3447）にも掛からず、通常の応答終了として「実行中」のまま放置された。
//
// 守っているのは3つ。
//
//   1. 1回目は`Stop`フックの`{"decision":"block"}`で差し戻す（固定文面。承認は生成しない）
//   2. 差し戻しで続けたターン（`stop_hook_active`）でも同じ形なら、`plan_not_presented`で引き上げる。
//      引き上げは1回だけで、送れなかったときは印を残さず次の`Stop`で送り直す
//   3. 計画モード外・提示済み・承認後・文章での問いかけ・Codexは対象外
//
// 転記のフィクスチャは#4496の実物（Claude Code 2.1.296）の形を写している
// （`attachment.type`の`plan_mode`／`plan_mode_exit`、`Write`のtool_use）。

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/session-notify.sh");

let server;
let workDir;
let received;
/** 引き上げの受け口が失敗を返すか */
let failEscalation;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "session-notify-plan-unpresented-"));
  mkdirSync(path.join(workDir, ".claude", "plans"), { recursive: true });
  received = [];
  failEscalation = false;

  server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ path: url.pathname, body: JSON.parse(body || "null") });
      const failed = failEscalation && url.pathname === "/api/dispatch/sessions/interrupted";
      response.writeHead(failed ? 500 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(failed ? { error: "boom" } : { ok: true, updated: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  writeFileSync(
    path.join(workDir, "dispatch.env"),
    `APP_BASE_URL=http://127.0.0.1:${server.address().port}\nDISPATCH_SECRET=test-secret\n`,
  );
  writeFileSync(path.join(workDir, "notify.env"), "");
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

function planPath() {
  return path.join(workDir, ".claude", "plans", "goofy-squishing-milner.md");
}

const planModeEnter = () =>
  JSON.stringify({
    type: "attachment",
    attachment: { type: "plan_mode", reminderType: "full", isSubAgent: false, planFilePath: planPath(), planExists: false },
  });
const planModeExit = () =>
  JSON.stringify({ type: "attachment", attachment: { type: "plan_mode_exit", planFilePath: planPath(), planExists: true } });
const planWrite = (id = "toolu_write_1") =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Write", input: { file_path: planPath(), content: "## 要約" } }],
    },
  });
const exitPlanCall = () =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_exit", name: "ExitPlanMode", input: {} }] },
  });
const announce = () =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "計画ファイルを書き終えました。次の応答で承認を依頼します。" }] },
  });

function writeTranscript(lines) {
  const file = path.join(workDir, `transcript-${Math.random()}.jsonl`);
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  return file;
}

const ANNOUNCE = "計画ファイルを書き終えました。次の応答で承認を依頼します。";

function escalations() {
  return received.filter((entry) => entry.path === "/api/dispatch/sessions/interrupted");
}
function activityReports() {
  return received.filter((entry) => entry.path === "/api/dispatch/sessions/activity");
}

/** #4496と同じ形の`Stop`を流す */
function stopAfterAnnounce(transcript, extra = {}, env) {
  const child = runHookWithInput(
    {
      hook_event_name: "Stop",
      session_id: "sess-4496",
      permission_mode: "plan",
      transcript_path: transcript,
      last_assistant_message: ANNOUNCE,
      stop_hook_active: false,
      ...extra,
    },
    env,
  );
  return child;
}

/** フックを1回実行して標準出力（＝Claude Codeが読むStopフックの判定）を返す */
function runHookWithInput(hook, extraEnv = {}) {
  let stdout = "";
  const child = execFile("bash", [script, "4562", "issue-deck", "guchi-apps/issue-deck"], {
    encoding: "utf8",
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: workDir,
      TMUX: "",
      SESSION_NOTIFY_TMUX_SESSION: "issue-deck-issue-4562",
      ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "dispatch.env"),
      ISSUE_DECK_NOTIFY_ENV: path.join(workDir, "notify.env"),
      ...extraEnv,
    },
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
  child.stdin.end(JSON.stringify(hook));
  return done;
}

function parseBlock(stdout) {
  const line = stdout.trim().split("\n").find((l) => l.startsWith("{"));
  return line ? JSON.parse(line) : null;
}

describe("session-notify.sh 計画を提示せずに終えた応答（#4562）", () => {
  it("#4496の宣言文で終えた応答は、疑問符が無くても1回目は差し戻す", async () => {
    const transcript = writeTranscript([planModeEnter(), planWrite(), announce()]);

    const stdout = await stopAfterAnnounce(transcript);

    const block = parseBlock(stdout);
    expect(block).toMatchObject({ decision: "block" });
    expect(block.reason).toContain("ExitPlanMode");
    expect(block.reason).toContain("承認はユーザーが行います");
    // セッションは止まっていないので、様子も引き上げも送らない
    expect(received).toEqual([]);
  });

  it("差し戻しで続けたターンでも提示しなければ、理由付きで1回だけ引き上げる", async () => {
    const transcript = writeTranscript([planModeEnter(), planWrite(), announce()]);

    await stopAfterAnnounce(transcript);
    const second = await stopAfterAnnounce(transcript, { stop_hook_active: true });
    const third = await stopAfterAnnounce(transcript, { stop_hook_active: true });

    expect(parseBlock(second)).toBeNull();
    expect(parseBlock(third)).toBeNull();
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0].body).toMatchObject({
      repository: "guchi-apps/issue-deck",
      issue: 4562,
      tmuxSessionName: "issue-deck-issue-4562",
      reason: "plan_not_presented",
    });
    expect(escalations()[0].body.detail).toContain("承認できる状態ではありません");
    // 1回目の引き上げでは様子を入力待ちにし、2回目以降は通常の応答終了として報告する
    expect(activityReports().map((r) => r.body.activity)).toEqual(["waiting_input", "responded"]);
  });

  it("差し戻しの印があれば stop_hook_active が無くても繰り返し差し戻さない", async () => {
    const transcript = writeTranscript([planModeEnter(), planWrite(), announce()]);

    await stopAfterAnnounce(transcript);
    const second = await stopAfterAnnounce(transcript);

    expect(parseBlock(second)).toBeNull();
    expect(escalations()).toHaveLength(1);
  });

  it("引き上げを送れなかったときは印を残さず、次のStopで送り直す", async () => {
    const transcript = writeTranscript([planModeEnter(), planWrite(), announce()]);
    await stopAfterAnnounce(transcript);

    failEscalation = true;
    await stopAfterAnnounce(transcript, { stop_hook_active: true });
    failEscalation = false;
    await stopAfterAnnounce(transcript, { stop_hook_active: true });

    expect(escalations()).toHaveLength(2);
    expect(escalations().every((e) => e.body.reason === "plan_not_presented")).toBe(true);
  });

  it("計画を書き直したら（新しい書き込み）、人の指示のあとにもう一度だけ差し戻せる", async () => {
    const first = writeTranscript([planModeEnter(), planWrite("toolu_a"), announce()]);
    await stopAfterAnnounce(first);
    const rewritten = writeTranscript([planModeEnter(), planWrite("toolu_a"), announce(), planWrite("toolu_b"), announce()]);

    const stdout = await stopAfterAnnounce(rewritten);

    expect(parseBlock(stdout)).toMatchObject({ decision: "block" });
  });

  it("提示済み（書き込みより後にExitPlanMode）・承認後（plan_mode_exit）は対象外", async () => {
    const presented = writeTranscript([planModeEnter(), planWrite(), exitPlanCall(), announce()]);
    const approved = writeTranscript([planModeEnter(), planWrite(), exitPlanCall(), planModeExit(), announce()]);

    const a = await stopAfterAnnounce(presented);
    const b = await stopAfterAnnounce(approved, {
      permission_mode: "auto",
      last_assistant_message: "PRを作成しました: https://github.com/guchi-apps/issue-deck/pull/1",
    });

    expect(parseBlock(a)).toBeNull();
    expect(parseBlock(b)).toBeNull();
    expect(escalations()).toEqual([]);
    expect(activityReports().map((r) => r.body.activity)).toEqual(["responded", "responded"]);
  });

  it("計画モード外（permission_modeがplan以外）・計画ファイルを書いていないStopは対象外", async () => {
    const transcript = writeTranscript([planModeEnter(), planWrite(), announce()]);
    const noWrite = writeTranscript([planModeEnter(), announce()]);

    const a = await stopAfterAnnounce(transcript, { permission_mode: "auto" });
    const b = await stopAfterAnnounce(noWrite);

    expect(parseBlock(a)).toBeNull();
    expect(parseBlock(b)).toBeNull();
    expect(escalations()).toEqual([]);
  });

  it("サブエージェントの行（isSidechain）の計画書き込みは本人の計画として読まない", async () => {
    const sidechainWrite = JSON.stringify({ ...JSON.parse(planWrite()), isSidechain: true });
    const transcript = writeTranscript([planModeEnter(), sidechainWrite, announce()]);

    const stdout = await stopAfterAnnounce(transcript);

    expect(parseBlock(stdout)).toBeNull();
    expect(escalations()).toEqual([]);
  });

  it("文章での問いかけで終えた応答は question_asked を優先し、差し戻さない", async () => {
    const transcript = writeTranscript([planModeEnter(), planWrite(), announce()]);

    const stdout = await stopAfterAnnounce(transcript, {
      last_assistant_message: "計画を書きました。\n\nA案とB案のどちらで進めますか？",
    });

    expect(parseBlock(stdout)).toBeNull();
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0].body.reason).toBe("question_asked");
  });

  // 計画レビューG1の指摘。Codexも同じスクリプトの`Stop`を使う
  it("Codexのセッションでは差し戻しも引き上げもしない", async () => {
    const transcript = writeTranscript([planModeEnter(), planWrite(), announce()]);

    const stdout = await stopAfterAnnounce(transcript, {}, { ISSUE_DECK_AGENT: "codex" });

    expect(parseBlock(stdout)).toBeNull();
    expect(escalations()).toEqual([]);
  });
});
