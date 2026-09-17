// `session-notify.sh`がissue-deckへ送る様子の報告（`POST /api/dispatch/sessions/activity`）を
// 固定する（#2280）。
//
// **Signalyへのwebhook通知を削除したため、この報告が「人へ届く唯一の経路」になった。**
// 守っているのは3つ。
//
//   1. 入力待ち（`Notification / permission_prompt`）で`checkUserRequested`が立つ
//      ——ここが立たないと`00.check-user`が付かず、Push通知も鳴らない
//   2. APIエラーで中断（pollerが合成する`SessionInterrupted`。#1971）は、様子の受け口ではなく
//      `POST /api/dispatch/sessions/interrupted`へ、宛先と`detail`を添えて送る
//      ——`activity`を持たない合図なので、様子の報告に相乗りさせると理由ラベルが`input`になり、
//      何が起きたのかもIssueに残らない
//   3. 応答終了（`Stop`）では立たない——毎ターン確認待ちにしない
//   4. ただし**auto modeのクラシファイアに拒否されたまま終わった`Stop`**は、様子ではなく
//      引き上げの受け口へ送る（#2844）——この形は`Notification`が飛ばないので、ここを通さないと
//      「応答が終わった」として`00.check-user`まで外れ、人を待っていることが画面から消える
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
 * `HOME`をテスト用のディレクトリへ向けるので、状態ファイル（`~/.local/state/...`）はそちらへ
 * 書かれる＝走っている実セッションの記録を汚さない。
 */
function runHook(hookJson) {
  const child = execFile("bash", [script, "2280", "issue-deck", "guchi-apps/issue-deck"], {
    encoding: "utf8",
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: workDir,
      TMUX: "",
      SESSION_NOTIFY_TMUX_SESSION: "issue-deck-issue-2280",
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

/**
 * 転記（JSONL）を作ってパスを返す（#2844）。
 *
 * 判定は**行単位の文字列一致**（`"type":"tool_use"` と拒否の決まり文句の、最後の出現位置の
 * 前後関係）なので、テストもレコードの最小形だけを置く。
 */
function writeTranscript(lines) {
  const file = path.join(workDir, `transcript-${received.length}-${Math.random()}.jsonl`);
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  return file;
}

/** ツールを実際に呼び出したassistantレコード。 */
const toolUse = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
});

/** auto modeのクラシファイアが拒否したときのtool_result（`Notification`は飛ばない）。 */
const classifierDenial = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        content:
          "Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier.",
      },
    ],
  },
});

/** 拒否のあと、説明のテキストだけを出してターンを終えたassistantレコード。 */
const assistantText = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "ブロックされました" }] },
});

function escalations() {
  return received.filter((entry) => entry.path === "/api/dispatch/sessions/interrupted");
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

  // #1971の引き上げ。**`activity`を持たないので、様子の報告に相乗りさせる実装だと
  // 理由ラベルが`01.check-input`になり、`detail`の行き先も無くなる。**
  // Signalyを消した（#2280）今はここだけが「APIエラーで止まったまま」を人へ届ける。
  it("APIエラーで中断した合図は、様子ではなく専用の受け口へ宛先つきで送る", async () => {
    await runHook({
      hook_event_name: "SessionInterrupted",
      session_id: "sess-1",
      interrupt_detail: "API Error: 529 Overloaded",
    });

    expect(activityReports()).toEqual([]);
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0].body).toMatchObject({
      repository: "guchi-apps/issue-deck",
      issue: 2280,
      hostName: expect.any(String),
      tmuxSessionName: "issue-deck-issue-2280",
      detail: "API Error: 529 Overloaded",
    });
  });

  it("idle_prompt と SessionStart では何も送らない", async () => {
    await runHook({ hook_event_name: "Notification", notification_type: "idle_prompt" });
    await runHook({ hook_event_name: "SessionStart", session_id: "sess-1" });

    expect(received).toEqual([]);
  });

  // #2844。クラシファイアの拒否には承認プロンプトが伴わず`Notification`が飛ばないため、
  // `Stop`をそのまま様子として報告すると、人を待っていること自体が画面から消える。
  it("クラシファイアに拒否されたまま終わった応答は、引き上げの受け口へ送る", async () => {
    const transcript = writeTranscript([toolUse, classifierDenial, assistantText]);

    await runHook({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcript });

    expect(escalations()).toHaveLength(1);
    expect(escalations()[0].body).toMatchObject({
      repository: "guchi-apps/issue-deck",
      issue: 2280,
      tmuxSessionName: "issue-deck-issue-2280",
      reason: "classifier_blocked",
    });
  });

  // 様子を送らないと「生きていて入力待ちでもない」＝まだ動いている、と判定され、確認待ちの
  // 件数から外れてトーストも最大10分保留される（`lib/workflow-badge-activity.ts`）。
  // Push通知だけが鳴る形になり、「画面に出ない」という元の症状が半分残る。
  it("画面の様子も入力待ちにする。ただしラベルの付け外しはこの往復に載せない", async () => {
    const transcript = writeTranscript([toolUse, classifierDenial, assistantText]);

    await runHook({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcript });

    expect(activityReports()).toHaveLength(1);
    expect(activityReports()[0].body).toMatchObject({
      activity: "waiting_input",
      checkUserRequested: false,
      planResolved: false,
    });
  });

  // 拒否されたコマンドにはシークレットが混ざりうるうえ、Issueコメントは公開リポジトリに残る。
  it("引き上げの本文に転記の中身を載せない", async () => {
    const transcript = writeTranscript([toolUse, classifierDenial, assistantText]);

    await runHook({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcript });

    expect(escalations()[0].body.detail).not.toContain("Blocked by classifier");
    expect(escalations()[0].body.detail).toContain("auto modeのクラシファイア");
  });

  it("拒否のあとにツールが走っていれば（迂回できていれば）これまでどおり応答終了として報告する", async () => {
    const transcript = writeTranscript([classifierDenial, toolUse, assistantText]);

    await runHook({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcript });

    expect(escalations()).toEqual([]);
    expect(activityReports()).toHaveLength(1);
    expect(activityReports()[0].body).toMatchObject({ activity: "responded" });
  });

  // `Stop`はターンごとに飛ぶので、印が無いと拒否が続くあいだIssueコメントが増え続ける。
  it("同じ停止で二度は引き上げない", async () => {
    const transcript = writeTranscript([toolUse, classifierDenial, assistantText]);

    await runHook({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcript });
    await runHook({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcript });

    expect(escalations()).toHaveLength(1);
    // 2回目は引き上げず、これまでどおり応答終了として報告するだけ
    expect(activityReports().map((entry) => entry.body.activity)).toEqual([
      "waiting_input",
      "responded",
    ]);
  });

  // 印が消えないと、一度引き上げたセッションが次に同じ形で止まったとき誰にも伝わらない。
  it("拒否のまま終わらなかった応答があれば、次の拒否をまた引き上げる", async () => {
    const blocked = writeTranscript([toolUse, classifierDenial, assistantText]);
    const recovered = writeTranscript([classifierDenial, toolUse, assistantText]);

    await runHook({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: blocked });
    await runHook({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: recovered });
    await runHook({ hook_event_name: "Stop", session_id: "sess-1", transcript_path: blocked });

    expect(escalations()).toHaveLength(2);
  });

  it("転記が渡らない・読めない場合はこれまでどおり応答終了として報告する", async () => {
    await runHook({
      hook_event_name: "Stop",
      session_id: "sess-1",
      transcript_path: path.join(workDir, "missing.jsonl"),
    });

    expect(escalations()).toEqual([]);
    expect(activityReports()).toHaveLength(1);
  });
});

// #2971。許可待ちの直後の`PostToolUse`を「人が答えた」と読んでよいのは、**許可を求めたツール
// そのものが走ったときだけ**。asset-manager #451では、裏で動くExploreサブエージェントの
// ツール実行で付与の3秒後に`00.check-user`が外れ、付与から3分待つPush通知が鳴らなかった。
describe("session-notify.sh の許可待ち（#2971）", () => {
  const permissionRequest = (toolName, toolInput, extra = {}) => ({
    hook_event_name: "PermissionRequest",
    session_id: "sess-1",
    tool_name: toolName,
    tool_input: toolInput,
    ...extra,
  });
  const postToolUse = (toolName, toolInput, extra = {}) => ({
    hook_event_name: "PostToolUse",
    session_id: "sess-1",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: {},
    tool_use_id: "toolu_1",
    ...extra,
  });
  const waitingPrompt = {
    hook_event_name: "Notification",
    notification_type: "permission_prompt",
    session_id: "sess-1",
  };
  const workingReports = () =>
    activityReports().filter((entry) => entry.body?.activity === "working");

  it("許可待ちの報告に、ツール名と対象を添える", async () => {
    await runHook(permissionRequest("Read", { file_path: "/tmp/issue-deck-images/a.png" }));
    expect(received).toEqual([]);
    await runHook(waitingPrompt);

    expect(activityReports()).toHaveLength(1);
    expect(activityReports()[0].body).toMatchObject({
      activity: "waiting_input",
      checkUserRequested: true,
      waitingTool: "Read",
      waitingTarget: "/tmp/issue-deck-images/a.png",
    });
  });

  it("Bashのコマンド本文とURLのパスは載せない", async () => {
    await runHook(permissionRequest("Bash", { command: "curl -H 'Authorization: secret-token' x" }));
    await runHook(waitingPrompt);
    await runHook({ hook_event_name: "Stop", session_id: "sess-1" });
    await runHook(permissionRequest("WebFetch", { url: "https://example.com/path?token=abc" }));
    await runHook(waitingPrompt);

    const waits = activityReports().filter((entry) => entry.body?.activity === "waiting_input");
    expect(waits[0].body).toMatchObject({ waitingTool: "Bash", waitingTarget: null });
    expect(JSON.stringify(received)).not.toContain("secret-token");
    expect(waits[1].body).toMatchObject({ waitingTool: "WebFetch", waitingTarget: "example.com" });
    expect(JSON.stringify(received)).not.toContain("token=abc");
  });

  it("記録の無い質問の待ちには、ツール名を添えない", async () => {
    await runHook(waitingPrompt);
    expect(activityReports()[0].body).not.toHaveProperty("waitingTool");
  });

  it("サブエージェントや別のツールの完了では、入力待ちを解かない", async () => {
    await runHook(permissionRequest("Read", { file_path: "/tmp/b.png" }));
    await runHook(waitingPrompt);
    await runHook(postToolUse("Grep", { pattern: "x", path: "/repo" }, { agent_id: "a1" }));
    await runHook(postToolUse("Read", { file_path: "/tmp/a.png" }));
    await runHook(postToolUse("Read", { file_path: "/tmp/b.png" }, { agent_id: "a1" }));

    expect(workingReports()).toEqual([]);
  });

  it("許可を求めたツールそのものが走ったら、入力待ちを解く", async () => {
    await runHook(permissionRequest("Read", { file_path: "/tmp/b.png" }));
    await runHook(waitingPrompt);
    await runHook(postToolUse("Read", { file_path: "/tmp/b.png", offset: 1 }));

    expect(workingReports()).toHaveLength(1);
    expect(workingReports()[0].body).toMatchObject({ planResolved: true });
  });

  it("サブエージェントが求めた許可は、そのサブエージェントの実行で解く", async () => {
    await runHook(permissionRequest("Bash", { command: "ls" }, { agent_id: "a1" }));
    await runHook(waitingPrompt);
    await runHook(postToolUse("Bash", { command: "ls" }));
    expect(workingReports()).toEqual([]);

    await runHook(postToolUse("Bash", { command: "ls" }, { agent_id: "a1" }));
    expect(workingReports()).toHaveLength(1);
  });

  it("記録が無い入力待ちでは、サブエージェントの実行だけを捨てる", async () => {
    await runHook(waitingPrompt);
    await runHook(postToolUse("Grep", { pattern: "x" }, { agent_id: "a1" }));
    expect(workingReports()).toEqual([]);

    await runHook(postToolUse("AskUserQuestion", { questions: [] }));
    expect(workingReports()).toHaveLength(1);
  });

  it("応答が終わったら記録を消し、次の質問に古い説明を添えない", async () => {
    await runHook(permissionRequest("Read", { file_path: "/tmp/b.png" }));
    await runHook(waitingPrompt);
    await runHook({ hook_event_name: "Stop", session_id: "sess-1" });
    await runHook(waitingPrompt);
    await runHook(postToolUse("AskUserQuestion", { questions: [] }));

    const waits = activityReports().filter((entry) => entry.body?.activity === "waiting_input");
    expect(waits[1].body).not.toHaveProperty("waitingTool");
    expect(workingReports()).toHaveLength(1);
  });
});
