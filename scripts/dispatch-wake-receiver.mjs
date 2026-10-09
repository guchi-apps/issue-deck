#!/usr/bin/env node
// サブPCのジョブ即時通知の受信サービス（#4200）。issue-deckがジョブを保存した直後に
// Tailscale内から届く合図を受け、起床ファイルを更新するだけ。**poller本体とは別プロセス**
// （別のsystemd unit）なので、このサービスを再起動しても実行中のセッション・tmuxには触れない。
//
// 設計の要点:
// - 受け付けるのは `POST /wake` だけ。本文は読まず捨てる。コマンド・プロンプトを受け取る口は無い
// - 署名（HMAC・宛先ホスト名と時刻に紐づく）と60秒の時刻窓で検証する。鍵は`DISPATCH_SECRET`の派生
// - 待ち受けは`WAKE_LISTEN_ADDR`（tailnetのアドレス）だけ。0.0.0.0・::・未指定は起動を拒否する
// - 通知を受けても何も取得・起動しない。起床ファイルを見たpollerが既存のclaim経路を前倒しで1巡する
// - ログに秘密値・署名・アドレスは出さない
import http from "node:http";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { verifyWake, WAKE_PATH } from "./lib/dispatch-wake-protocol.mjs";

const secret = process.env.DISPATCH_SECRET ?? "";
const hostName = process.env.DISPATCH_HOST_NAME || hostname().split(".")[0];
const listenAddr = process.env.WAKE_LISTEN_ADDR ?? "";
const listenPort = Number(process.env.WAKE_LISTEN_PORT ?? "4290");
const wakeFile = process.env.DISPATCH_WAKE_FILE || `${process.env.XDG_RUNTIME_DIR || "/tmp"}/issue-deck-dispatch-wake`;

if (!secret) { console.error("DISPATCH_SECRET が未設定です。"); process.exit(1); }
if (!listenAddr || ["0.0.0.0", "::", "::0"].includes(listenAddr)) {
  console.error("WAKE_LISTEN_ADDR にはtailnetのアドレスを指定してください（全インターフェースでの待ち受けは拒否します）。");
  process.exit(1);
}
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  console.error("WAKE_LISTEN_PORT が不正です。"); process.exit(1);
}

function writeWake(timestampMs) {
  mkdirSync(dirname(wakeFile), { recursive: true });
  const tmp = `${wakeFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${timestampMs}\n`, { mode: 0o600 });
  renameSync(tmp, wakeFile); // 重複通知は同じファイルの上書きに畳まれる
}

const server = http.createServer((req, res) => {
  req.resume(); // 本文は読まない
  const fail = (code) => { res.writeHead(code).end(); };
  if (req.method !== "POST" || req.url !== WAKE_PATH) return fail(404);
  const result = verifyWake({
    dispatchSecret: secret,
    hostName,
    timestamp: req.headers["x-wake-timestamp"],
    signature: req.headers["x-wake-signature"],
  });
  if (!result.ok) {
    console.error(`通知を拒否しました: ${result.reason}`);
    return fail(401);
  }
  try {
    writeWake(result.timestampMs);
  } catch (error) {
    console.error(`起床ファイルを書けませんでした: ${error?.code ?? "error"}`);
    return fail(500);
  }
  console.log(`通知を受信しました（送信から ${Date.now() - result.timestampMs}ms）`);
  res.writeHead(204).end();
});
server.requestTimeout = 5_000;
server.headersTimeout = 5_000;
server.maxHeadersCount = 30;
server.listen(listenPort, listenAddr, () => console.log(`即時通知の受信を開始しました（ポート ${listenPort}）`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
