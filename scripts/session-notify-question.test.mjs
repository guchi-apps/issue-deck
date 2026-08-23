// `AskUserQuestion`で聞いたあと、画面からの回答を待つ経路（#2189）の境界を固定する。
//
// 守っているのは2つ。**(1) 回答は`allow`＋`updatedInput.answers`で返す**——`AskUserQuestion`は
// 入力に`answers`が入っていればそれをそのまま結果にし、フックが`updatedInput`を返したときだけ
// 「許可が下りていても人へ聞き直す」挙動が省かれる（#2121で計画について確かめたのと同じ仕組み）。
// ここが緩むと、画面で答えたのに端末にも選択フォームが出る二重回答に戻る。
// **(2) 決まらなければ何も出さない**——端末に従来どおりの選択フォームが出る（フェイルオープン）。
//
// 実物のセッションは立てられないので、issue-deckの代わりに返すだけのHTTPサーバーを置き、
// フックのJSONを流し込んで**標準出力に出る許可判定**を見る（`session-notify-plan.test.mjs`と同じ形）。

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
/** `GET /decision`が返す応答を先頭から1つずつ使う。尽きたら最後のものを繰り返す */
let decisionQueue;
/** 「待つのをやめた」の申告（`POST /decision`）が返す応答 */
let releaseResponse;
/** 受け取ったリクエストの記録（メソッドとパスだけ） */
let received;

function ok(body) {
  return { code: 200, body };
}
function fail() {
  return { code: 500, body: { error: "boom" } };
}

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "session-notify-question-"));
  decisionQueue = [];
  releaseResponse = ok({ status: "DEFERRED", answers: null });
  received = [];

  server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    received.push(`${request.method} ${url.pathname}`);

    const send = (entry) => {
      response.writeHead(entry.code, { "Content-Type": "application/json" });
      response.end(JSON.stringify(entry.body));
    };

    if (url.pathname === "/api/dispatch/sessions/question" && request.method === "POST") {
      request.resume();
      send(ok({ ok: true, labeled: true, questionRequestId: "req-1" }));
      return;
    }
    if (url.pathname === "/api/dispatch/sessions/question/decision" && request.method === "GET") {
      send(decisionQueue.length > 1 ? decisionQueue.shift() : (decisionQueue[0] ?? fail()));
      return;
    }
    if (url.pathname === "/api/dispatch/sessions/question/decision" && request.method === "POST") {
      request.resume();
      send(releaseResponse ?? fail());
      return;
    }
    send({ code: 404, body: { error: "not_found" } });
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

/** `PreToolUse(AskUserQuestion)`のフックJSON */
const TOOL_INPUT = {
  questions: [
    {
      question: "認証方式はどれにしますか？",
      header: "認証",
      options: [
        { label: "Supabase Auth", description: "既存アプリと同じ" },
        { label: "NextAuth", description: "自由度が高い" },
      ],
      multiSelect: false,
    },
  ],
};
const HOOK_JSON = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: TOOL_INPUT,
  transcript_path: "",
});

/**
 * フックを1回実行して標準出力（＝Claude Codeが読む許可判定）を返す。
 *
 * **同期実行にしない。** 返事を返すHTTPサーバーがこのプロセスに居るため、イベントループを
 * 止めると自分で自分の返事を止めることになり、必ず「届かない」側に倒れる。
 */
function runHook() {
  const child = execFile("bash", [script, "2189", "issue-deck", "guchi-apps/issue-deck"], {
    encoding: "utf8",
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: workDir,
      TMUX: "",
      SESSION_NOTIFY_TMUX_SESSION: "",
      SESSION_NOTIFY_WEBHOOK_URL: "",
      SIGNALY_WEBHOOK_URL: "",
      ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "dispatch.env"),
      ISSUE_DECK_NOTIFY_ENV: path.join(workDir, "notify.env"),
      SESSION_QUESTION_WAIT_SECONDS: "30",
      SESSION_PLAN_POLL_INTERVAL_SECONDS: "1",
      SESSION_PLAN_POLL_GRACE_SECONDS: "2",
    },
  });
  const done = new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
  child.stdin.end(HOOK_JSON);
  return done;
}

/** 標準出力のJSONから許可判定を取り出す。何も出ていなければ`null`（＝端末へ倒す） */
function decisionOf(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed).hookSpecificOutput;
}

const ANSWERS = { "認証方式はどれにしますか？": "Supabase Auth" };

describe("質問への回答待ち", () => {
  // **`allow`だけでは端末に選択フォームが出る。** 回答そのものは`updatedInput.answers`に
  // 載せて渡し、質問（`questions`）は受け取ったままを添える（作り変えるとスキーマ検証で弾かれる）
  it("回答は`allow`＋`updatedInput.answers`で返す", async () => {
    decisionQueue = [ok({ status: "ANSWERED", answers: ANSWERS })];

    const decision = decisionOf(await runHook());

    expect(decision).toMatchObject({
      permissionDecision: "allow",
      updatedInput: { ...TOOL_INPUT, answers: ANSWERS },
    });
  });

  it("issue-deckが一時的に応答しなくても待ち続け、回答を受け取る", async () => {
    decisionQueue = [
      fail(),
      fail(),
      ok({ status: "WAITING" }),
      ok({ status: "ANSWERED", answers: ANSWERS }),
    ];

    const decision = decisionOf(await runHook());

    expect(decision).toMatchObject({ permissionDecision: "allow" });
  });

  it("「端末で答える」なら何も返さない（端末に選択フォームが出る）", async () => {
    decisionQueue = [ok({ status: "DEFERRED", answers: null })];

    expect(decisionOf(await runHook())).toBeNull();
  });

  // 空の`answers`を返すとツールの結果が「(no option selected)」になり、
  // 端末で答え直す機会も無いまま先へ進む
  it("回答が空なら何も返さない", async () => {
    decisionQueue = [ok({ status: "ANSWERED", answers: {} })];

    expect(decisionOf(await runHook())).toBeNull();
  });

  it("届かない状態が続いたら降り、画面の待ちも畳ませる", async () => {
    decisionQueue = [fail()];

    const decision = decisionOf(await runHook());

    expect(decision).toBeNull();
    // **画面へ「もう受け取れない」と伝える。** 伝えないと押しても届かないボタンが残る
    expect(received).toContain("POST /api/dispatch/sessions/question/decision");
  });

  it("降りる直前に押されていたら、待ちを畳む往復の応答をそのまま使う", async () => {
    decisionQueue = [fail()];
    releaseResponse = ok({ status: "ANSWERED", answers: ANSWERS });

    const decision = decisionOf(await runHook());

    expect(decision).toMatchObject({ permissionDecision: "allow" });
  });
}, 60_000);
