#!/usr/bin/env node
// Issue #258: 指定URLに対し、CIログインバイパス用Cookie（#257）をセットしたうえで
// 任意個数の撮影対象（名前・パス・デバイス種別の組）をそれぞれスクリーンショット撮影する。
//
// Issue #567: 従来は「1つのURLをデスクトップ+モバイルで各1枚」の固定構成だったが、
// スマホのみ複数画面（ホーム・イシュー一覧・イシュー詳細）を撮影したいケースに
// 対応するため、撮影対象を可変長で受け取れる汎用形に変更した。
//
// CI_BYPASS_COOKIE_NAME の値は src/lib/ci-auth-bypass.ts と必ず一致させること
// （scripts/ci-seed-user.mjs と同じ理由で、プレーンJSのスクリプトからTSファイルを
// 直接importせず値を直書きしている）。
//
// 使い方:
//   CI_LOGIN_BYPASS_SECRET=... node scripts/capture-screenshots.mjs <ベースURL> <出力ディレクトリ> <名前:パス:device> [<名前:パス:device>...]
//   device は "desktop" または "mobile"
//
// 出力: <出力ディレクトリ>/<名前>.png （撮影対象ごとに1枚）

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, devices } from "playwright";

const CI_BYPASS_COOKIE_NAME = "ci-login-bypass";

const [, , baseUrl, outDir, ...targetArgs] = process.argv;

if (!baseUrl || !outDir || targetArgs.length === 0) {
  console.error(
    "Usage: node scripts/capture-screenshots.mjs <ベースURL> <出力ディレクトリ> <名前:パス:device> [<名前:パス:device>...]",
  );
  process.exit(1);
}

const secret = process.env.CI_LOGIN_BYPASS_SECRET;
if (!secret) {
  console.error("Error: CI_LOGIN_BYPASS_SECRET が設定されていません。");
  process.exit(1);
}

const targets = targetArgs.map((arg) => {
  const [name, targetPath, device] = arg.split(":");
  if (!name || !targetPath || (device !== "desktop" && device !== "mobile")) {
    console.error(`Error: 撮影対象の指定が不正です（<名前:パス:device>の形式で指定してください）: ${arg}`);
    process.exit(1);
  }
  return { name, targetPath, device };
});

const hostname = new URL(baseUrl).hostname;

async function capture({ name, targetPath, device }) {
  const targetUrl = new URL(targetPath, baseUrl).toString();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(
      device === "mobile" ? devices["iPhone 13"] : { viewport: { width: 1440, height: 900 } },
    );
    await context.addCookies([
      {
        name: CI_BYPASS_COOKIE_NAME,
        value: secret,
        domain: hostname,
        path: "/",
      },
    ]);
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "load" });
    // クライアント側のレンダリング・フォント読み込みが落ち着くまでの猶予。
    await page.waitForTimeout(500);
    const filePath = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.error(`撮影しました: ${filePath} (${targetUrl})`);
  } finally {
    await browser.close();
  }
}

await mkdir(outDir, { recursive: true });

for (const target of targets) {
  await capture(target);
}
