// AIが画像を読むための取得スクリプト（`scripts/fetch-issue-images.sh`・#2967）の振る舞いを固定する。
//
// 配信APIは認証必須になったため、このスクリプトが鍵を付けて取りに行く。いちばん守りたいのは
// **鍵を設定のAPP_BASE_URL以外へ送らないこと**で、本文に別ホストのURLが紛れていても
// そのホストへは接続しない。実物のissue-deckは立てられないので、鍵を検証するだけの
// HTTPサーバーを配信APIに見立てる。

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/fetch-issue-images.sh");

const SECRET = "test-secret";
const IMAGE_A = "aaaaaaaa-1111-2222-3333-444444444444.png";
const IMAGE_B = "bbbbbbbb-1111-2222-3333-444444444444.jpg";
const IMAGE_SVG = "cccccccc-1111-2222-3333-444444444444.svg";

let server;
let baseUrl;
/** 配信APIが受け取ったリクエスト（パスとAuthorization） */
let received;
let workDir;

beforeEach(async () => {
  received = [];
  server = createServer((request, res) => {
    received.push({ url: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401).end();
      return;
    }
    if (request.url === `/api/issues/images/${IMAGE_A}`) {
      res.writeHead(200, { "Content-Type": "image/png" }).end("PNGDATA");
      return;
    }
    if (request.url === `/api/issues/images/${IMAGE_B}`) {
      res.writeHead(200, { "Content-Type": "image/jpeg" }).end("JPGDATA");
      return;
    }
    if (request.url === `/api/issues/images/${IMAGE_SVG}`) {
      res.writeHead(200, { "Content-Type": "image/svg+xml" }).end("<svg></svg>");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  workDir = mkdtempSync(path.join(tmpdir(), "fetch-issue-images-"));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

function run(args, { input = "", env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "bash",
      [script, "--out", path.join(workDir, "out"), ...args],
      {
        env: {
          PATH: process.env.PATH,
          HOME: workDir,
          ISSUE_DECK_IMAGE_BASE_URL: baseUrl,
          ISSUE_DECK_IMAGE_SECRET: SECRET,
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
    // 引数だけでURLを渡すテストでは、スクリプトが標準入力を読まずに先に終了することがある。
    // その場合ここへのwriteはEPIPEになるが、プロセスの終了コード自体は`error`経由で
    // 正しく取れているので、このストリームエラーは無視してよい。
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

describe("fetch-issue-images.sh", () => {
  it("本文中の画像を鍵付きで取得し、保存先のパスを出す（同じ画像は1回だけ）", async () => {
    const body = [
      `![a](https://issue-deck.example/api/issues/images/${IMAGE_A})`,
      `![b](https://issue-deck.example/api/issues/images/${IMAGE_B})`,
      `![a again](https://issue-deck.example/api/issues/images/${IMAGE_A})`,
      "![github](https://user-images.githubusercontent.com/1/x.png)",
    ].join("\n");

    const result = await run(["-"], { input: body });

    expect(result.code).toBe(0);
    const paths = result.stdout.trim().split("\n");
    expect(paths).toEqual([
      path.join(workDir, "out", IMAGE_A),
      path.join(workDir, "out", IMAGE_B),
    ]);
    expect(readFileSync(paths[0], "utf8")).toBe("PNGDATA");
    expect(received.map((r) => r.url)).toEqual([
      `/api/issues/images/${IMAGE_A}`,
      `/api/issues/images/${IMAGE_B}`,
    ]);
  });

  it("SVGも取得して保存する（#3286。AIはReadでXMLテキストとして読める）", async () => {
    const result = await run(["-"], {
      input: `![icon](https://issue-deck.example/api/issues/images/${IMAGE_SVG})`,
    });

    expect(result.code).toBe(0);
    const paths = result.stdout.trim().split("\n");
    expect(paths).toEqual([path.join(workDir, "out", IMAGE_SVG)]);
    expect(readFileSync(paths[0], "utf8")).toBe("<svg></svg>");
  });

  it("URLのホストではなく、設定の取得先へ鍵を送る（別ホストへ鍵を漏らさない）", async () => {
    // 本文のURLは別ホストを指しているが、接続先はテスト用サーバー（設定の取得先）だけになる
    const result = await run([`https://attacker.invalid/api/issues/images/${IMAGE_A}`]);

    expect(result.code).toBe(0);
    expect(received).toEqual([
      { url: `/api/issues/images/${IMAGE_A}`, authorization: `Bearer ${SECRET}` },
    ]);
  });

  it("鍵がコマンドライン引数に載らない", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("--header @-");
    expect(source).not.toMatch(/--header\s+"Authorization/);
  });

  it("画像URLが無ければ何もせず0で終わる", async () => {
    const result = await run(["-"], { input: "画像なしの本文" });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(received).toEqual([]);
  });

  it("取得できなかったものがあれば2で終わり、途中のファイルを残さない", async () => {
    const missing = "cccccccc-1111-2222-3333-444444444444.png";
    const result = await run([`/api/issues/images/${missing}`], {
      env: { ISSUE_DECK_IMAGE_SECRET: "wrong" },
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("HTTP 401");
    expect(existsSync(path.join(workDir, "out", missing))).toBe(false);
    expect(existsSync(path.join(workDir, "out", `${missing}.part`))).toBe(false);
  });

  it("取得先も鍵も無ければ1で終わる（dispatch.envも無い環境）", async () => {
    const result = await run([`/api/issues/images/${IMAGE_A}`], {
      env: { ISSUE_DECK_IMAGE_BASE_URL: "", ISSUE_DECK_IMAGE_SECRET: "" },
    });

    expect(result.code).toBe(1);
    expect(received).toEqual([]);
  });
});
