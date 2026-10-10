#!/usr/bin/env node
// サーバー（TypeScript）とiOSアプリ（Swift）で揃えておく値・判定が食い違っていないかを照合する。
// Xcodeの無い環境（subpc・CI）でも動く。`pnpm test:unit` の `test/ios-consistency.test.ts`
// が同じ関数を使う。単独でも `node ios/scripts/check-consistency.mjs` で実行できる。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf-8");

/** 問題の一覧を返す（空なら整合している）。 */
export function checkConsistency() {
  const problems = [];
  const appConfig = read("ios/IssueDeck/AppConfig.swift");
  const nativeApp = read("src/lib/native-auth/native-app.ts");
  const webViewModel = read("ios/IssueDeck/WebViewModel.swift");
  const nativeAuth = read("ios/IssueDeck/NativeAuth.swift");
  const pbxproj = read("ios/IssueDeck.xcodeproj/project.pbxproj");

  const swiftScheme = appConfig.match(/authCallbackScheme = "([^"]+)"/)?.[1];
  const tsScheme = nativeApp.match(/NATIVE_SCHEME = "([^"]+)"/)?.[1];
  if (!swiftScheme || swiftScheme !== tsScheme) {
    problems.push(`戻り先スキームが一致しません: Swift=${swiftScheme} / TS=${tsScheme}`);
  }

  // 戻り先のホスト（auth-callback）
  for (const host of ["auth-callback"]) {
    if (!nativeApp.includes(`://${host}`)) problems.push(`native-app.ts に ${host} がありません`);
    if (!webViewModel.includes(`"${host}"`)) problems.push(`WebViewModel.swift に ${host} がありません`);
  }

  // 横取りするパスは、Web側の入口と同じ
  for (const path of ["/auth/v1/authorize"]) {
    if (!appConfig.includes(`"${path}"`)) problems.push(`AppConfig.swift が ${path} を横取りしていません`);
  }
  // 引き継ぎの経路
  for (const path of ["auth/native/start", "/auth/native/consume"]) {
    if (!webViewModel.includes(path)) problems.push(`WebViewModel.swift が ${path} を使っていません`);
  }

  // 同一オリジン判定は、スキーム・ホスト・ポートまで見る（IssueDeck外はWebViewへ読み込まない）
  if (!/url\.scheme == baseURL\.scheme && url\.host == baseURL\.host && url\.port == baseURL\.port/.test(appConfig)) {
    problems.push("AppConfig.isAppURL がスキーム・ホスト・ポートの一致を見ていません");
  }
  if (!/openExternally\(url\)\s*\n\s*return \.cancel/.test(webViewModel)) {
    problems.push("WebViewModel.swift が外部URLをSafariで開いて .cancel していません");
  }

  // 認証シートは毎回エフェメラル（Safariの既存セッションに触れない）
  if (!nativeAuth.includes("prefersEphemeralWebBrowserSession = true")) {
    problems.push("認証シートがエフェメラルではありません");
  }

  // Bundle ID・表示名
  if (!pbxproj.includes("PRODUCT_BUNDLE_IDENTIFIER = com.gucchii.issuedeck;")) problems.push("Bundle ID が com.gucchii.issuedeck ではありません");
  if (!pbxproj.includes("INFOPLIST_KEY_CFBundleDisplayName = IssueDeck;")) problems.push("表示名が IssueDeck ではありません");

  // 共有メニュー（#3847）。App Group・上限・拡張の組み込みがアプリ本体と食い違わない
  const shareDraft = read("ios/Shared/ShareDraft.swift");
  const appGroup = shareDraft.match(/appGroupID = "([^"]+)"/)?.[1];
  for (const file of ["ios/Config/IssueDeck.entitlements", "ios/Config/ShareExtension.entitlements"]) {
    if (!appGroup || !read(file).includes(`<string>${appGroup}</string>`)) {
      problems.push(`${file} に App Group ${appGroup} がありません`);
    }
  }
  const imagesRoute = read("src/app/api/issues/images/route.ts");
  const serverMax = imagesRoute.match(/MAX_FILE_SIZE = (\d+) \* 1024 \* 1024/)?.[1];
  const swiftMax = shareDraft.match(/maxImageBytes = (\d+) \* 1024 \* 1024/)?.[1];
  if (!serverMax || serverMax !== swiftMax) {
    problems.push(`画像の上限が一致しません: Swift=${swiftMax}MB / サーバー=${serverMax}MB`);
  }
  if (!pbxproj.includes("com.apple.product-type.app-extension") || !pbxproj.includes("Embed Foundation Extensions")) {
    problems.push("共有メニュー（Share Extension）がアプリへ組み込まれていません");
  }

  // 開発用のURLをコミットしていない
  if (!/baseURL = URL\(string: "https:\/\/issuedeck\.gucchii\.com\/"\)!/.test(appConfig)) {
    problems.push("AppConfig.baseURL が本番URLではありません（開発用のまま？）");
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkConsistency();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✖ ${problem}`);
    process.exit(1);
  }
  console.log("iOSアプリとサーバーの整合: OK");
}
