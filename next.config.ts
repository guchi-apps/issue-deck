import type { NextConfig } from "next";

// 開発サーバーの内部リソース（`/_next/*`・HMRのWebSocket）は、既定でクロスオリジンからの
// アクセスが403になる。localhost以外のホスト名で開発サーバーを開くには、そのホストを
// allowedDevOriginsに載せる必要がある。
//
// ワイルドカードは**末尾の`**`だけが複数ラベルに一致する**（`*`は1ラベルのみ）。
// Next.jsの実装（server/app-render/csrf-protection.ts）がドット区切りで後ろから突き合わせる
// ためで、`*.sslip.io`では`172.20.5.3.sslip.io`（4ラベル+2）に一致しない。
const DEFAULT_DEV_ORIGINS = [
  "localhost",
  "127.0.0.1",
  // WSLのIPはWSL再起動のたびに変わるため、個別IPではなくsslip.ioサブドメイン全体を許可する
  "**.sslip.io",
  // Tailscale（MagicDNSの `<ホスト名>.<tailnet>.ts.net`）経由でスマホ等から見るため（#1178）
  "**.ts.net",
];

// MagicDNSの短い名前（`subpc`）や生のtailnet IP（`100.x.x.x`）で開く場合など、上記で足りない
// ホストは `.env.local` の ISSUE_DECK_DEV_ALLOWED_ORIGINS にカンマ区切りで足す。
// 開発サーバー起動時のみ効き、本番ビルドの挙動には関与しない。
const extraDevOrigins = (process.env.ISSUE_DECK_DEV_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// `output: "standalone"`は置かない。元はFly.ioプレビュー環境のDocker化のために入れた設定
// だが、そのプレビューは#1308で廃止済みで、本番はPM2から`next start`で起動している
// （`deploy/ecosystem.config.js`）。両者は併用できず、起動のたびに
// `"next start" does not work with "output: standalone" configuration.`という警告が
// 本番ログへ出続けていたため外した（#2366）。使わない`.next/standalone`がビルド成果物に
// 入って転送量が増える問題も同時に消える。
const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: [...DEFAULT_DEV_ORIGINS, ...extraDevOrigins],
};

export default nextConfig;
