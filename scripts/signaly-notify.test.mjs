// CI・デプロイ通知（`.github/scripts/signaly-notify.sh`）が、Signalyの停止でrunを赤くしない
// ことを固定する（#2237）。
//
// v4.33.0のmainマージでは、tag/build/deploy/releaseが全て成功しているのに通知の`curl`が503で
// 落ち、`Deploy to Production`のrunが失敗になった。通知は結果の記録であって成否そのものでは
// ないため、届かなくても終了コードは0で返す。
//
// 実物のSignalyは立てられないので、指定した応答を返すだけのHTTPサーバーをwebhookに見立てる。

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, ".github/scripts/signaly-notify.sh");

let server;
let webhookUrl;
/** webhookが返す応答（テストごとに差し替える） */
let response;
/** 受け取ったリクエストのボディ */
let received;

beforeEach(async () => {
  response = { code: 204, body: "" };
  received = [];

  server = createServer((request, res) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(response.code, { "Content-Type": "application/json" });
      res.end(response.body);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // webhookのURLは秘密なので、失敗時のログに出ていないことも見る（ここでは目印を入れておく）。
  webhookUrl = `http://127.0.0.1:${server.address().port}/hooks/secret-token`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function run(env = {}) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [script],
      {
        env: {
          ...process.env,
          SIGNALY_WEBHOOK_URL: webhookUrl,
          NOTIFY_APP: "issue-deck",
          NOTIFY_KIND: "デプロイ",
          NOTIFY_STATUS: "success",
          GITHUB_REPOSITORY: "guchi-apps/issue-deck",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_RUN_ID: "1",
          ...env,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

describe("signaly-notify.sh", () => {
  it("通知が届けば成功で終わる", async () => {
    const result = await run();

    expect(result.code).toBe(0);
    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0]);
    expect(payload.title).toBe("✅ [issue-deck] デプロイ 成功");
  });

  it(
    "Signalyが503を返しても成功で終わり、警告だけ残す",
    async () => {
      response = { code: 503, body: "<html>Service Unavailable</html>" };

      const result = await run();

      // ここが要点。**通知の失敗でrunを落とさない**
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("::warning::");
      // 原因の切り分けに使うので、HTTPコードとcurlの終了コードは警告に残す
      expect(result.stdout).toContain("503");
      expect(result.stdout).toContain("curl exit 22");
      // 一時エラーは再試行する（Signaly自身の再起動中に当たった503を拾うため）
      expect(received.length).toBeGreaterThan(1);
      // webhookのURLはそれ自体が投稿権限を持つシークレットなので、失敗時も出さない
      expect(result.stdout + result.stderr).not.toContain("secret-token");
    },
    30_000,
  );

  it("webhookへ繋がらなくても成功で終わる", async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createServer(() => {});

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("::warning::");
  });

  it("SIGNALY_WEBHOOK_URLが未設定なら何もせずに終わる", async () => {
    const result = await run({ SIGNALY_WEBHOOK_URL: "" });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("skipping Signaly notification");
    expect(received).toHaveLength(0);
  });
});
