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
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
/** 質問の登録（`POST /question`）で受け取った本文 */
let questionPayloads;

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
  questionPayloads = [];

  server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    received.push(`${request.method} ${url.pathname}`);

    const send = (entry) => {
      response.writeHead(entry.code, { "Content-Type": "application/json" });
      response.end(JSON.stringify(entry.body));
    };

    if (url.pathname === "/api/dispatch/sessions/question" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        questionPayloads.push(JSON.parse(body));
        send(ok({ ok: true, labeled: true, questionRequestId: "req-1" }));
      });
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
function runHook(hookJson = HOOK_JSON) {
  const child = execFile("bash", [script, "2189", "issue-deck", "guchi-apps/issue-deck"], {
    encoding: "utf8",
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: workDir,
      TMUX: "",
      SESSION_NOTIFY_TMUX_SESSION: "",
      ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "dispatch.env"),
      ISSUE_DECK_NOTIFY_ENV: path.join(workDir, "notify.env"),
      SESSION_QUESTION_WAIT_SECONDS: "30",
      SESSION_PLAN_POLL_INTERVAL_SECONDS: "1",
      // 2秒だと、CIの負荷が高いときにcurl・python3の起動オーバーヘッドだけで猶予を
      // 使い切り、2回連続の失敗をシミュレートするテストが本物の再試行の前に諦めてしまう
      // （#2255）。同じ経路を検証する session-notify-plan.test.mjs は6秒を使っており、
      // それに合わせる。
      SESSION_PLAN_POLL_GRACE_SECONDS: "6",
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
  child.stdin.end(hookJson);
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

// 質問の前提（#3569・#3809）。差し戻したあとの呼び直しで、差し戻した応答の本文を転記から
// 読んで`context`として送る。ここでは「直前に差し戻した」印と転記を先に置いて、呼び直しの
// 時点を再現する
describe("質問の前提", () => {
  const SESSION_ID = "session-3809";

  /** 差し戻した応答（同じ`message.id`のブロックを1行ずつ）を転記に置き、呼び直しのフックJSONを返す */
  function retriedHookJson(blocks) {
    const markerDir = path.join(workDir, ".local/state/issue-deck/sessions/question-retry");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      path.join(markerDir, createHash("sha256").update(SESSION_ID).digest("hex").slice(0, 32)),
      "0\n",
    );
    const transcript = path.join(workDir, "transcript.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: "前の指示" } },
      { type: "assistant", message: { id: "msg-old", content: [{ type: "text", text: "前の応答の本文" }] } },
      ...[...blocks, { type: "tool_use", name: "AskUserQuestion", input: TOOL_INPUT }].map((block) => ({
        type: "assistant",
        message: { id: "msg-asked", content: [block] },
      })),
    ];
    writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    return JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: TOOL_INPUT,
      transcript_path: transcript,
      session_id: SESSION_ID,
    });
  }

  async function sentContext(blocks) {
    decisionQueue = [ok({ status: "DEFERRED", answers: null })];
    await runHook(retriedHookJson(blocks));
    expect(questionPayloads).toHaveLength(1);
    return questionPayloads[0].context;
  }

  it("同じ応答の本文（text）を前提として送る", async () => {
    expect(await sentContext([{ type: "text", text: "上記のコードを実行します" }])).toBe(
      "上記のコードを実行します",
    );
  });

  // 前置きを思考に書いて質問すると、Claudeアプリには引用の見た目で出るのに画面には
  // 何も出なかった（#3809）
  it("本文の入った思考（thinking）も引用にして送る", async () => {
    expect(
      await sentContext([
        { type: "thinking", thinking: "App Store Connectで新規App作成が必要です。\n\nその後TestFlightへ進みます。", signature: "x" },
        { type: "text", text: "確認します" },
      ]),
    ).toBe("> App Store Connectで新規App作成が必要です。\n>\n> その後TestFlightへ進みます。\n\n確認します");
  });

  // 転記の思考はふつう署名だけで空。空の引用を前提に出さない
  it("空の思考は拾わない", async () => {
    expect(
      await sentContext([
        { type: "thinking", thinking: "", signature: "x" },
        { type: "text", text: "上記のコードを実行します" },
      ]),
    ).toBe("上記のコードを実行します");
  });
}, 60_000);
