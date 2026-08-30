import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/submit-question.sh");
let server;
let baseUrl;
let requests;
let decisions;
let releaseDecision;
let workDir;
let configFile;
let questionsFile;

beforeEach(async () => {
  requests = [];
  decisions = [{ status: "ANSWERED", answers: { "どう進めますか？": "修正する" } }];
  releaseDecision = { status: "DEFERRED", answers: null };
  server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ authorization: request.headers.authorization, body, method: request.method, url: request.url });
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url === "/api/dispatch/sessions/question") {
        response.end('{"ok":true,"labeled":true,"questionRequestId":"request-1"}');
      } else if (request.method === "POST") {
        response.end(JSON.stringify(releaseDecision));
      } else {
        response.end(JSON.stringify(decisions.shift() ?? { status: "WAITING", answers: null }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  workDir = mkdtempSync(path.join(tmpdir(), "submit-question-"));
  configFile = path.join(workDir, "dispatch.env");
  questionsFile = path.join(workDir, "questions.json");
  writeFileSync(configFile, `APP_BASE_URL=${baseUrl}\nDISPATCH_SECRET=test-secret\n`, "utf8");
  writeFileSync(questionsFile, JSON.stringify([{
    header: "進め方",
    question: "どう進めますか？",
    options: [
      { label: "修正する", description: "修正を続けます" },
      { label: "停止する", description: "作業を止めます" },
    ],
    multiSelect: false,
  }]), "utf8");
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

function run(env = {}) {
  return new Promise((resolve) => {
    execFile("bash", [script, questionsFile], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ISSUE_DECK_DISPATCH_ENV: configFile,
        ISSUE_SESSION_REPOSITORY: "guchi-apps/issue-deck",
        ISSUE_SESSION_ISSUE_NUMBER: "2579",
        DISPATCH_HOST_NAME: "test-host",
        SESSION_QUESTION_WAIT_SECONDS: "3",
        SESSION_PLAN_POLL_INTERVAL_SECONDS: "1",
        ...env,
      },
    }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

describe("submit-question.sh", () => {
  it("質問と対象を送信し、画面の回答をJSONで返す", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ "どう進めますか？": "修正する" });
    expect(requests[0].url).toBe("/api/dispatch/sessions/question");
    expect(requests[0].authorization).toBe("Bearer test-secret");
    expect(JSON.parse(requests[0].body)).toMatchObject({
      repository: "guchi-apps/issue-deck",
      issue: 2579,
      hostName: "test-host",
      waitSeconds: 3,
      questions: [{ question: "どう進めますか？", multiSelect: false }],
    });
  });

  it("WAITINGのあとに回答されるまでポーリングする", async () => {
    decisions = [{ status: "WAITING", answers: null }, { status: "ANSWERED", answers: { "どう進めますか？": "停止する" } }];
    const result = await run();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ "どう進めますか？": "停止する" });
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(2);
  });

  it("端末で回答する選択を終了コード2で返す", async () => {
    decisions = [{ status: "DEFERRED", answers: null }];
    const result = await run();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("端末でユーザーへ確認してください");
  });

  it("期限切れ時は待機を解放して終了コード3を返す", async () => {
    decisions = [{ status: "WAITING", answers: null }];
    const result = await run({ SESSION_QUESTION_WAIT_SECONDS: "1" });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("期限切れ");
    expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/decision"))).toBe(true);
  });

  it("期限切れ直前に届いた回答は解除APIの最終応答から受け取る", async () => {
    decisions = [{ status: "WAITING", answers: null }];
    releaseDecision = { status: "ANSWERED", answers: { "どう進めますか？": "修正する" } };
    const result = await run({ SESSION_QUESTION_WAIT_SECONDS: "1" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ "どう進めますか？": "修正する" });
  });

  it("返事待ちIDが無ければ回答済みとして進めない", async () => {
    server.removeAllListeners("request");
    server.on("request", (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true,"labeled":true,"questionRequestId":null}');
    });
    const result = await run();
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("返事待ちを作れませんでした");
  });

  it("壊れたJSONは送信しない", async () => {
    writeFileSync(questionsFile, "not json", "utf8");
    const result = await run();
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("JSONとして読めません");
    expect(requests).toHaveLength(0);
  });
});
