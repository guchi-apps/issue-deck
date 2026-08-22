// 計画を出したあと、画面からの返事を待つ経路（#2061）の境界を固定する（#2108）。
//
// **1回のHTTP失敗で待ちを降りて、画面にだけカウントダウンが残った**（#2103の2回目の計画。
// フックは108秒で終了し、以降どのボタンもセッションへ届かなかった）。宛先は本番のissue-deckで、
// 30分待つあいだに数百回引くため、途中で失敗することは普通に起きる。ここが緩むと
// 「Claude Code側には計画が出ているのに、issue-deckからは承認も修正もできない」に戻る。
//
// 実物のセッションは立てられないので、issue-deckの代わりに返すだけのHTTPサーバーを置き、
// フックのJSONを流し込んで**標準出力に出る許可判定**を見る。

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
/** 「待つのをやめた」の申告（`POST /decision`）が返す応答。`null`なら申告を受け付けない */
let releaseResponse;
/** 受け取ったリクエストの記録（メソッドとパスだけ） */
let received;

/** `{status: ...}`をそのまま返す応答。`code`が2xx以外ならcurlは失敗として扱う（`-f`） */
function ok(body) {
  return { code: 200, body };
}
function fail() {
  return { code: 500, body: { error: "boom" } };
}

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "session-notify-plan-"));
  decisionQueue = [];
  releaseResponse = ok({ status: "DEFERRED", revisionText: null });
  received = [];

  server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    received.push(`${request.method} ${url.pathname}`);

    const send = (entry) => {
      response.writeHead(entry.code, { "Content-Type": "application/json" });
      response.end(JSON.stringify(entry.body));
    };

    if (url.pathname === "/api/dispatch/sessions/plan" && request.method === "POST") {
      request.resume();
      send(ok({ ok: true, posted: true, planRequestId: "req-1" }));
      return;
    }
    if (url.pathname === "/api/dispatch/sessions/plan/decision" && request.method === "GET") {
      send(decisionQueue.length > 1 ? decisionQueue.shift() : (decisionQueue[0] ?? fail()));
      return;
    }
    if (url.pathname === "/api/dispatch/sessions/plan/decision" && request.method === "POST") {
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

/** `PreToolUse(ExitPlanMode)`のフックJSON。計画本文は引数で渡ってくる版に合わせる */
const HOOK_JSON = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "ExitPlanMode",
  tool_input: { plan: "## 要約\n\n**やることを1行で。**" },
  transcript_path: "",
});

/**
 * フックを1回実行して標準出力（＝Claude Codeが読む許可判定）を返す。
 *
 * **同期実行（`execFileSync`）にしない。** 返事を返すHTTPサーバーがこのプロセスに居るため、
 * イベントループを止めると自分で自分の返事を止めることになり、必ず「届かない」側に倒れる。
 */
function runHook() {
  const child = execFile("bash", [script, "2108", "issue-deck", "guchi-apps/issue-deck"], {
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
      SESSION_PLAN_WAIT_SECONDS: "30",
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

describe("計画への返事待ち", () => {
  it("issue-deckが一時的に応答しなくても待ち続け、承認を受け取る", async () => {
    decisionQueue = [fail(), fail(), ok({ status: "WAITING" }), ok({ status: "APPROVED" })];

    const decision = decisionOf(await runHook());

    expect(decision).toMatchObject({ permissionDecision: "allow" });
  });

  // **`allow`だけでは端末に承認プロンプトが出る**（#2121）。Claude Codeは`ExitPlanMode`を
  // 「許可が下りていても人へ聞き直す」ツールとして扱い、フックが`updatedInput`を返したときだけ
  // その聞き直しを省く。ここが落ちると、画面で承認したあとRemote Controlでもう一度承認する
  // 二重承認へ戻る。
  it("承認には`updatedInput`（受け取った引数そのまま）を添える", async () => {
    decisionQueue = [ok({ status: "APPROVED" })];

    const decision = decisionOf(await runHook());

    expect(decision).toMatchObject({
      permissionDecision: "allow",
      updatedInput: JSON.parse(HOOK_JSON).tool_input,
    });
  });

  it("修正は`deny`＋書かれた本文で返す（そのまま次の指示になる）", async () => {
    decisionQueue = [ok({ status: "REVISION_REQUESTED", revisionText: "C1の指摘を反映して" })];

    const decision = decisionOf(await runHook());

    expect(decision).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: "C1の指摘を反映して",
    });
    // `deny`はもともと聞き直されずClaudeへ渡るので、引数を差し替える理由が無い
    expect(decision).not.toHaveProperty("updatedInput");
  });

  it("届かない状態が続いたら降り、画面の待ちも畳ませる", async () => {
    decisionQueue = [fail()];

    const decision = decisionOf(await runHook());

    // 何も返さない＝端末に従来どおりの承認プロンプトが出る（フェイルオープン）
    expect(decision).toBeNull();
    // **画面へ「もう受け取れない」と伝える。** 伝えないと押しても届かないボタンが残る
    expect(received).toContain("POST /api/dispatch/sessions/plan/decision");
  });

  it("降りる直前に押されていたら、待ちを畳む往復の応答をそのまま使う", async () => {
    decisionQueue = [fail()];
    releaseResponse = ok({ status: "APPROVED", revisionText: null });

    const decision = decisionOf(await runHook());

    expect(decision).toMatchObject({ permissionDecision: "allow" });
  });
}, 60_000);
