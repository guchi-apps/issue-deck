// CI・デプロイ通知（`.github/scripts/signaly-notify.sh`）が、Signalyの停止でrunを赤くしない
// ことを固定する（#2237）。
//
// v4.33.0のmainマージでは、tag/build/deploy/releaseが全て成功しているのに通知の`curl`が503で
// 落ち、`Deploy to Production`のrunが失敗になった。通知は結果の記録であって成否そのものでは
// ないため、届かなくても終了コードは0で返す。
//
// 実物のSignalyは立てられないので、指定した応答を返すだけのHTTPサーバーをwebhookに見立てる。

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, ".github/scripts/signaly-notify.sh");

let server;
let webhookUrl;
/** リリース専用チャンネルに見立てた2本目のwebhook（#2391） */
let releaseServer;
let releaseWebhookUrl;
/** リリース専用チャンネルが受け取ったリクエストのボディ */
let releaseReceived;
/** 変更内容のファイルを置く一時ディレクトリ */
let workDir;
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

  releaseReceived = [];
  releaseServer = createServer((request, res) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      releaseReceived.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => releaseServer.listen(0, "127.0.0.1", resolve));
  releaseWebhookUrl = `http://127.0.0.1:${releaseServer.address().port}/hooks/release`;

  workDir = mkdtempSync(path.join(tmpdir(), "signaly-notify-"));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => releaseServer.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

/** 変更内容のファイルを書き、そのパスを返す */
function writeNotes(contents) {
  const notesPath = path.join(workDir, "release-notes.md");
  writeFileSync(notesPath, contents, "utf8");
  return notesPath;
}

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

/** リリース通知として実行する。既定では変更内容のファイルを持たない（#2391） */
function runRelease(env = {}) {
  return run({
    NOTIFY_KIND: "リリース",
    NOTIFY_VERSION: "v4.45.0",
    GITHUB_SHA: "a1f9c02d4e5f6789012345678901234567890abc",
    NOTIFY_NOTES_FILE: path.join(workDir, "absent.md"),
    ...env,
  });
}

const fieldNames = (payload) => payload.fields.map((field) => field.name);
const fieldValue = (payload, name) => payload.fields.find((field) => field.name === name)?.value;

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

  it("CI・デプロイ通知には本文を付けず、従来のフィールドを出す", async () => {
    await run({ GITHUB_REF_NAME: "main", GITHUB_ACTOR: "guchi", GITHUB_EVENT_NAME: "push" });

    const payload = JSON.parse(received[0]);
    expect(payload.message).toBeUndefined();
    expect(fieldNames(payload)).toContain("Type");
    expect(fieldNames(payload)).toContain("Branch");
    expect(fieldNames(payload)).toContain("Actor");
  });

  // ── リリース通知の分離（#2391）───────────────────────────────
  describe("リリース通知", () => {
    it("リリース専用のwebhookがあればそちらへ送る", async () => {
      const result = await runRelease({ SIGNALY_RELEASE_WEBHOOK_URL: releaseWebhookUrl });

      expect(result.code).toBe(0);
      // ここが要点。**CI・デプロイのチャンネルには流さない**
      expect(received).toHaveLength(0);
      expect(releaseReceived).toHaveLength(1);
    });

    it("リリース専用のwebhookが未設定なら従来のチャンネルへ送る", async () => {
      // 配布先のワークフローがまだ渡していなくても通知が消えないことを固定する
      const result = await runRelease();

      expect(result.code).toBe(0);
      expect(received).toHaveLength(1);
      expect(releaseReceived).toHaveLength(0);
    });

    it("成功したリリースの見出しは🚀になる", async () => {
      await runRelease();

      expect(JSON.parse(received[0]).title).toBe("🚀 [issue-deck] リリース v4.45.0 成功");
    });

    it("失敗したリリースの見出しは❌のままにする", async () => {
      await runRelease({ NOTIFY_STATUS: "failure" });

      expect(JSON.parse(received[0]).title).toBe("❌ [issue-deck] リリース v4.45.0 失敗");
    });

    it("毎回同じ値になるフィールドを落とし、GitHub Releaseへのリンクを出す", async () => {
      await runRelease({ GITHUB_REF_NAME: "main", GITHUB_ACTOR: "guchi", GITHUB_EVENT_NAME: "push" });

      const payload = JSON.parse(received[0]);
      expect(fieldNames(payload)).toEqual(["App", "Version", "Repository", "Commit", "Release", "Run"]);
      expect(fieldValue(payload, "Release")).toBe(
        "[v4.45.0](https://github.com/guchi-apps/issue-deck/releases/tag/v4.45.0)",
      );
    });

    it("見出しのバージョンが一致する変更内容を本文に載せる", async () => {
      const notes = writeNotes(
        [
          "<!-- リリースのたびに自動生成されます。手で編集しないでください -->",
          "",
          "# v4.45.0",
          "",
          "リリースの通知が別のチャンネルに届くようになりました。",
          "",
          "**使い方**",
          "",
          "1. Signalyで「リリース」チャンネルを開く",
          "",
        ].join("\n"),
      );

      await runRelease({ NOTIFY_NOTES_FILE: notes });

      const payload = JSON.parse(received[0]);
      expect(payload.message).toContain("リリースの通知が別のチャンネルに届くようになりました。");
      expect(payload.message).toContain("1. Signalyで「リリース」チャンネルを開く");
      // 断り書きのHTMLコメントと見出しは本文に混ぜない
      expect(payload.message).not.toContain("<!--");
      expect(payload.message).not.toContain("# v4.45.0");
    });

    it("見出しのバージョンが違えば、古い文面の代わりにフォールバック文言を載せる", async () => {
      // 古い文面を新しいバージョンの通知に貼るより、「更新内容なし」と伝えるほうがまし
      const notes = writeNotes("# v4.44.0\n\n前のリリースの文面\n");

      await runRelease({ NOTIFY_NOTES_FILE: notes });

      expect(JSON.parse(received[0]).message).toBe("今回のリリースでは、表示できる更新内容がありません。");
    });

    it("変更内容のファイルが無くても通知は送り、フォールバック文言を載せる", async () => {
      const result = await runRelease({ NOTIFY_NOTES_FILE: path.join(workDir, "missing.md") });

      expect(result.code).toBe(0);
      expect(JSON.parse(received[0]).message).toBe("今回のリリースでは、表示できる更新内容がありません。");
    });

    it("本文が空のリリース通知には、空欄ではなくフォールバック文言を表示する", async () => {
      // #2683: 本文欄そのものが消えると「更新内容が無かった」のか「通知が壊れている」のか
      // 区別できない。理由(見出し不一致・ファイル不在など)を問わず一律でこの文言にする。
      const notes = writeNotes("<!-- 断り書き -->\n\n\n");

      await runRelease({ NOTIFY_NOTES_FILE: notes });

      const payload = JSON.parse(received[0]);
      expect(payload.message).toBe("今回のリリースでは、表示できる更新内容がありません。");
    });

    it("長すぎる変更内容は切り詰める", async () => {
      const notes = writeNotes(`# v4.45.0\n\n${"あ".repeat(3000)}\n`);

      await runRelease({ NOTIFY_NOTES_FILE: notes });

      const { message } = JSON.parse(received[0]);
      expect(message.length).toBeLessThanOrEqual(1501);
      expect(message.endsWith("…")).toBe(true);
    });
  });
});
