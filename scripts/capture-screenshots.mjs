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
// Issue #756: ダイアログ等、URLクエリパラメータだけでは表現できない画面状態（クリック操作が
// 必要なUI）を撮影できるよう、撮影対象の指定に第4フィールド（クリック対象セレクタ、任意）を
// 追加した。指定時はページ読み込み待機後にPlaywrightの`page.click(selector)`を実行してから
// 撮影する。セレクタ自体にコロンを含むケース（`button:has-text("...")`等）に対応するため、
// 4分割目以降は再結合してセレクタとして扱う。
//
// Issue #717: モバイルは撮影直前にdata-capture-scroll-bottom要素を最下部までスクロールする
// 仕様（下記）だが、画面上部（進捗ステップ等）を撮影したい場合はこのスクロールが邪魔になる。
// 撮影対象パスのURLフラグメントに#topを指定すると、このスクロールをスキップする。
//
// 使い方:
//   CI_LOGIN_BYPASS_SECRET=... node scripts/capture-screenshots.mjs <ベースURL> <出力ディレクトリ> <名前:パス:device[:クリック対象セレクタ]> [<名前:パス:device[:クリック対象セレクタ]>...]
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
  const [name, targetPath, device, ...selectorParts] = arg.split(":");
  if (!name || !targetPath || (device !== "desktop" && device !== "mobile")) {
    console.error(
      `Error: 撮影対象の指定が不正です（<名前:パス:device[:クリック対象セレクタ]>の形式で指定してください）: ${arg}`,
    );
    process.exit(1);
  }
  const clickSelector = selectorParts.length > 0 ? selectorParts.join(":") : undefined;
  return { name, targetPath, device, clickSelector };
});

const hostname = new URL(baseUrl).hostname;

// Issue #713: 実際のiPhone 15のスクリーンショットに近い見た目にするため、viewportは
// devices["iPhone 15"]（393x852）をそのまま使う。#572時点ではモバイル画面（src/components/
// dashboard/mobile/配下、ヘッダー固定+内部overflow-y-autoで本文をスクロールする構成）の
// 内部スクロール領域も1枚に収めるためviewport高さを2400まで拡張しfullPage撮影していたが、
// 実機ではあり得ない縦長画像になってしまっていた。実機同様のviewportサイズのまま
// （`fullPage: false`で）撮影し、内部スクロール領域は下記のとおり撮影直前に最下部へ
// スクロールしておくことで、はみ出す内容は「スクロール後の見え方」として1枚に収める。
const MOBILE_DEVICE = devices["iPhone 15"];

async function capture({ name, targetPath, device, clickSelector }) {
  const targetUrl = new URL(targetPath, baseUrl).toString();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(
      device === "mobile" ? MOBILE_DEVICE : { viewport: { width: 1440, height: 900 } },
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
    // クライアント側のレンダリング・フォント読み込み・コメント欄等クライアント側fetchが
    // 落ち着くまでの猶予（#572: コメント取得はクライアント側useEffect経由のため、
    // 短すぎると撮影時点で反映されないことがある）。
    await page.waitForTimeout(4000);
    if (clickSelector) {
      // クリック後、ダイアログのアニメーション等が収まるまでの猶予。
      await page.click(clickSelector);
      await page.waitForTimeout(500);
    }
    // Issue詳細画面のコメント欄はヘッダー固定+内部overflow-y-autoのため、モバイルは
    // viewportそのままの撮影（下記のとおりfullPage: false）だと下端（承認待ちカード等）が
    // 写らない。src/components/dashboard/issue-detail.tsx・mobile/mobile-issue-detail.tsxが
    // 目印として付与しているdata-capture-scroll-bottom要素を撮影前に最下部までスクロール
    // しておく。
    // Issue #717: 画面上部（進捗ステップ等）を撮影したいケースでは下端スクロールが逆に
    // 邪魔になるため、対象パスのURLフラグメントに#topを指定した場合はスクロールせず
    // 読み込み直後の（先頭にスクロールされた）状態のまま撮影する。
    if (new URL(page.url()).hash !== "#top") {
      await page.evaluate(() => {
        document.querySelectorAll("[data-capture-scroll-bottom]").forEach((element) => {
          element.scrollTop = element.scrollHeight;
        });
      });
    }
    await page.waitForTimeout(200);
    const filePath = path.join(outDir, `${name}.png`);
    // Issue #713: モバイルは実機のviewportサイズそのままの見た目にするため`fullPage: false`
    // （viewportに写っている範囲のみ）で撮影する。デスクトップ画面（/dashboard）は元々
    // 縦に長いレイアウトのため、従来どおりページ全体をfullPageで撮影する。
    await page.screenshot({ path: filePath, fullPage: device !== "mobile" });
    console.error(`撮影しました: ${filePath} (${targetUrl})`);
  } finally {
    await browser.close();
  }
}

await mkdir(outDir, { recursive: true });

for (const target of targets) {
  await capture(target);
}
