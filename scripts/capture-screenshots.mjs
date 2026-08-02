#!/usr/bin/env node
// Issue #258: 指定URLに対し、CIログインバイパス用Cookie（#257）をセットしたうえで
// デスクトップビューポートとモバイルデバイスプリセット（iPhone 13）の両方で
// スクリーンショットを撮影する。
//
// CI_BYPASS_COOKIE_NAME の値は src/lib/ci-auth-bypass.ts と必ず一致させること
// （scripts/ci-seed-user.mjs と同じ理由で、プレーンJSのスクリプトからTSファイルを
// 直接importせず値を直書きしている）。
//
// 使い方:
//   CI_LOGIN_BYPASS_SECRET=... node scripts/capture-screenshots.mjs <URL> <出力ディレクトリ>
//
// 出力: <出力ディレクトリ>/desktop.png, <出力ディレクトリ>/mobile.png

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chromium, devices } from "playwright";

const CI_BYPASS_COOKIE_NAME = "ci-login-bypass";

const [, , targetUrl, outDir] = process.argv;

if (!targetUrl || !outDir) {
  console.error("Usage: node scripts/capture-screenshots.mjs <URL> <出力ディレクトリ>");
  process.exit(1);
}

const secret = process.env.CI_LOGIN_BYPASS_SECRET;
if (!secret) {
  console.error("Error: CI_LOGIN_BYPASS_SECRET が設定されていません。");
  process.exit(1);
}

const url = new URL(targetUrl);

async function capture({ fileName, viewport, device }) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(device ?? { viewport });
    await context.addCookies([
      {
        name: CI_BYPASS_COOKIE_NAME,
        value: secret,
        domain: url.hostname,
        path: "/",
      },
    ]);
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "load" });
    // クライアント側のレンダリング・フォント読み込みが落ち着くまでの猶予。
    await page.waitForTimeout(500);
    const filePath = path.join(outDir, fileName);
    await page.screenshot({ path: filePath, fullPage: true });
    console.error(`撮影しました: ${filePath}`);
  } finally {
    await browser.close();
  }
}

await mkdir(outDir, { recursive: true });

await capture({
  fileName: "desktop.png",
  viewport: { width: 1440, height: 900 },
});

await capture({
  fileName: "mobile.png",
  device: devices["iPhone 13"],
});
