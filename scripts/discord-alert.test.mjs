// 異常通知（`.github/scripts/discord-alert.sh`）の送る・送らないの線引きを固定する（#5057）。
//
// 失敗・明確な異常だけをDiscordへ送り、成功・キャンセル・不明は送らない。通知先が落ちていても
// runは赤くしない。実物のDiscordは立てられないので、応答を返すだけのHTTPサーバーをwebhookに見立てる。

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, ".github/scripts/discord-alert.sh");

let server;
let webhookUrl;
let response;
let received;

beforeEach(async () => {
  response = { code: 204 };
  received = [];
  server = createServer((request, res) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(response.code);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  webhookUrl = `http://127.0.0.1:${server.address().port}/api/webhooks/secret-token`;
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
          DISCORD_ALERT_WEBHOOK_URL: webhookUrl,
          NOTIFY_APP: "issue-deck",
          NOTIFY_KIND: "CI",
          NOTIFY_STATUS: "failure",
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

describe("discord-alert.sh", () => {
  it("失敗はDiscordへ送る", async () => {
    const result = await run();

    expect(result.code).toBe(0);
    expect(received).toHaveLength(1);
    const embed = JSON.parse(received[0]).embeds[0];
    expect(embed.title).toBe("❌ [issue-deck] CI 失敗");
    expect(embed.fields.find((f) => f.name === "Run").value).toContain("/actions/runs/1");
    expect(JSON.parse(received[0]).allowed_mentions).toEqual({ parse: [] });
  });

  it("ワークフローが成功でも異常を表すもの（ドリフト検知など）は送る", async () => {
    const result = await run({ NOTIFY_STATUS: "anomaly", NOTIFY_DETAIL: "差分あり" });

    expect(result.code).toBe(0);
    const embed = JSON.parse(received[0]).embeds[0];
    expect(embed.title).toBe("⚠️ [issue-deck] CI 異常");
    expect(embed.fields.find((f) => f.name === "Detail").value).toBe("差分あり");
  });

  it.each(["success", "cancelled", "skipped", "unknown"])("%s は送らない", async (status) => {
    const result = await run({ NOTIFY_STATUS: status });

    expect(result.code).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("リリースの成功は送らず、失敗は送る（完了通知はissue-deck側の別経路）", async () => {
    await run({ NOTIFY_KIND: "リリース", NOTIFY_STATUS: "success", NOTIFY_VERSION: "v1.0.0" });
    expect(received).toHaveLength(0);

    await run({ NOTIFY_KIND: "リリース", NOTIFY_STATUS: "failure", NOTIFY_VERSION: "v1.0.0" });
    expect(JSON.parse(received[0]).embeds[0].title).toBe("❌ [issue-deck] リリース 失敗 v1.0.0");
  });

  it("webhook未設定でも0で返す", async () => {
    const result = await run({ DISCORD_ALERT_WEBHOOK_URL: "" });

    expect(result.code).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("Discordが503を返してもrunを落とさず、URLをログへ出さない", async () => {
    response = { code: 503 };

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("HTTP");
    expect(result.stdout + result.stderr).not.toContain("secret-token");
  }, 30000);

  it("接続できなくても0で返し、ホスト名・URLをログへ出さない", async () => {
    const result = await run({ DISCORD_ALERT_WEBHOOK_URL: "http://127.0.0.1:1/api/webhooks/secret-token" });

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("secret-token");
    expect(result.stdout + result.stderr).not.toContain("127.0.0.1");
  }, 30000);
});
