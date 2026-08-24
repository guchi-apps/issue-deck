// `session-notify.sh`がissue-deckへ送る様子の報告（`POST /api/dispatch/sessions/activity`）を
// 固定する（#2280）。
//
// **Signalyへのwebhook通知を削除したため、この報告が「人へ届く唯一の経路」になった。**
// 守っているのは3つ。
//
//   1. 入力待ち（`Notification / permission_prompt`）で`checkUserRequested`が立つ
//      ——ここが立たないと`00.check-user`が付かず、Push通知も鳴らない
//   2. APIエラーで中断（pollerが合成する`SessionInterrupted`。#1971）でも立つ
//      ——`activity`を持たない合図なので、報告そのものを飛ばしてしまう間違いを踏みやすい
//   3. 応答終了（`Stop`）では立たない——毎ターン確認待ちにしない
//
// 実物のissue-deckは立てられないので、受け取った本文を記録するだけのHTTPサーバーを置く
// （`session-notify-plan.test.mjs`と同じ形）。

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/session-notify.sh");

let server;
let baseUrl;
let workDir;
/** 受け取ったリクエスト（パスとJSON本文） */
let received;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "session-notify-activity-"));
  received = [];

  server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      received.push({ path: url.pathname, body: parsed });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, updated: 1 }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  writeFileSync(
    path.join(workDir, "dispatch.env"),
    `APP_BASE_URL=${baseUrl}\nDISPATCH_SECRET=test-secret\n`,
  );
  writeFileSync(path.join(workDir, "notify.env"), "");
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * フックを1回実行する。
 *
 * `HOME`をテスト用のディレクトリへ向けるので、状態ファイル（`~/.local/state/...`）も
 * `tmux`のセッション名も持たない状態で走る＝実セッションの記録を汚さない。
 */
function runHook(hookJson) {
  const child = execFile("bash", [script, "2280", "issue-deck", "guchi-apps/issue-deck"], {
    encoding: "utf8",
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: workDir,
      TMUX: "",
      SESSION_NOTIFY_TMUX_SESSION: "",
      ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "dispatch.env"),
      ISSUE_DECK_NOTIFY_ENV: path.join(workDir, "notify.env"),
    },
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  child.stdin.end(JSON.stringify(hookJson));
  return done;
}

function activityReports() {
  return received.filter((entry) => entry.path === "/api/dispatch/sessions/activity");
}

describe("session-notify.sh の様子の報告", () => {
  it("入力待ちでは checkUserRequested を立てて報告する", async () => {
    await runHook({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      session_id: "sess-1",
    });

    expect(activityReports()).toHaveLength(1);
    expect(activityReports()[0].body).toMatchObject({
      repository: "guchi-apps/issue-deck",
      issue: 2280,
      activity: "waiting_input",
      checkUserRequested: true,
    });
  });

  it("応答終了では checkUserRequested を立てない", async () => {
    await runHook({ hook_event_name: "Stop", session_id: "sess-1" });

    expect(activityReports()).toHaveLength(1);
    expect(activityReports()[0].body).toMatchObject({
      activity: "responded",
      checkUserRequested: false,
    });
  });

  // #1971の引き上げ。**`activity`を持たないので、報告ごと落とす実装だと黙って消える。**
  // Signalyを消した（#2280）今はここだけが「APIエラーで止まったまま」を人へ届ける。
  it("APIエラーで中断した合図は activity 無しで checkUserRequested だけを立てる", async () => {
    await runHook({
      hook_event_name: "SessionInterrupted",
      session_id: "sess-1",
      interrupt_detail: "API Error: 529 Overloaded",
    });

    expect(activityReports()).toHaveLength(1);
    expect(activityReports()[0].body).toMatchObject({ checkUserRequested: true });
    // `activity`は空（issue-deck側で`null`へ倒れる）。`working`等を勝手に名乗らせない
    expect(activityReports()[0].body.activity).toBe("");
  });

  it("idle_prompt と SessionStart では何も送らない", async () => {
    await runHook({ hook_event_name: "Notification", notification_type: "idle_prompt" });
    await runHook({ hook_event_name: "SessionStart", session_id: "sess-1" });

    expect(received).toEqual([]);
  });
});
