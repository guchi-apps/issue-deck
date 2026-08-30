import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/submit-plan.sh");
let server;
let baseUrl;
let requests;
let decisions;
let releaseDecision;
let workDir;
let configFile;
let planFile;

beforeEach(async () => {
  requests = [];
  decisions = [{ status: "APPROVED", revisionText: null }];
  releaseDecision = { status: "DEFERRED", revisionText: null };
  server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ authorization: request.headers.authorization, body, method: request.method, url: request.url });
      response.writeHead(200, { "Content-Type": "application/json" });
      if (request.url === "/api/dispatch/sessions/plan") {
        response.end('{"ok":true,"posted":true,"planRequestId":"request-1"}');
      } else if (request.method === "POST") {
        response.end(JSON.stringify(releaseDecision));
      } else {
        response.end(JSON.stringify(decisions.shift() ?? { status: "WAITING", revisionText: null }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  workDir = mkdtempSync(path.join(tmpdir(), "submit-plan-"));
  configFile = path.join(workDir, "dispatch.env");
  planFile = path.join(workDir, "plan.md");
  writeFileSync(configFile, `APP_BASE_URL=${baseUrl}\nDISPATCH_SECRET=test-secret\n`, "utf8");
  writeFileSync(planFile, "## 要約\n\n**テスト計画**\n", "utf8");
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

function run(env = {}) {
  return new Promise((resolve) => {
    execFile("bash", [script, planFile], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ISSUE_DECK_DISPATCH_ENV: configFile,
        ISSUE_SESSION_REPOSITORY: "guchi-apps/issue-deck",
        ISSUE_SESSION_ISSUE_NUMBER: "2545",
        DISPATCH_HOST_NAME: "test-host",
        SESSION_PLAN_WAIT_SECONDS: "3",
        SESSION_PLAN_POLL_INTERVAL_SECONDS: "1",
        ...env,
      },
    }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

describe("submit-plan.sh", () => {
  it("計画と対象を送信し、画面の承認を終了コード0で返す", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("承認されました");
    expect(requests[0].url).toBe("/api/dispatch/sessions/plan");
    expect(requests[0].authorization).toBe("Bearer test-secret");
    expect(JSON.parse(requests[0].body)).toMatchObject({
      repository: "guchi-apps/issue-deck", issue: 2545, hostName: "test-host",
      plan: "## 要約\n\n**テスト計画**\n", waitSeconds: 3,
    });
    expect(requests[1].url).toBe("/api/dispatch/sessions/plan/decision?id=request-1");
  });

  it("修正内容を終了コード2と標準エラーへ返す", async () => {
    decisions = [{ status: "REVISION_REQUESTED", revisionText: "影響範囲を追記してください" }];
    const result = await run();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("影響範囲を追記してください");
  });

  it("WAITINGのあとに承認されるまでポーリングする", async () => {
    decisions = [{ status: "WAITING" }, { status: "APPROVED" }];
    const result = await run();
    expect(result.code).toBe(0);
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(2);
  });

  it("期限切れ時は待機を解放して終了コード3を返す", async () => {
    decisions = [{ status: "WAITING" }];
    const result = await run({ SESSION_PLAN_WAIT_SECONDS: "1" });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("期限切れ");
    expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/decision"))).toBe(true);
  });

  it("期限切れ直前に届いた承認は解除APIの最終応答から受け取る", async () => {
    decisions = [{ status: "WAITING" }];
    releaseDecision = { status: "APPROVED", revisionText: null };
    const result = await run({ SESSION_PLAN_WAIT_SECONDS: "1" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("承認されました");
  });

  it("返事待ちIDが無ければ実装へ進めない", async () => {
    server.removeAllListeners("request");
    server.on("request", (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true,"posted":true,"planRequestId":null}');
    });
    const result = await run();
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("返事待ちを作れませんでした");
  });

  // #2551: 宛先と鍵は`notify.env`ではなく`dispatch.env`から読む。ここを取り違えていたため、
  // 実機では宛先が空のまま`exit 1`になり、画面に承認パネルが出なかった
  it("dispatch.envが無くても環境変数から宛先を読む", async () => {
    const result = await run({
      ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "missing.env"),
      APP_BASE_URL: baseUrl,
      DISPATCH_SECRET: "env-secret",
    });
    expect(result.code).toBe(0);
    expect(requests[0].authorization).toBe("Bearer env-secret");
  });

  it("宛先も鍵も見つからなければ送信しない", async () => {
    const result = await run({
      ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "missing.env"),
      APP_BASE_URL: "",
      DISPATCH_SECRET: "",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("APP_BASE_URL / DISPATCH_SECRET が見つかりません");
    expect(requests).toHaveLength(0);
  });
});
