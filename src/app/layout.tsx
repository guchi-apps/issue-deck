import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
// Murecho・BIZ UDPGothicは@fontsourceパッケージ（npm経由でフォントファイル本体を配布）で自己ホストする。
// next/font/googleのCJKフォントはこの開発環境から fonts.gstatic.com に到達できずビルドが失敗するため使わない。
import "@fontsource/murecho/400.css";
import "@fontsource/murecho/500.css";
import "@fontsource/murecho/600.css";
import "@fontsource/murecho/700.css";
// Issue本文・コメントのMarkdown表示（長文の読み物）専用。UI全体のMurechoより
// 可読性を優先し、ユニバーサルデザインフォントのBIZ UDPGothicを使う。
import "@fontsource/biz-udpgothic/400.css";
import "@fontsource/biz-udpgothic/700.css";
import "./globals.css";

import packageJson from "../../package.json";
import { AppUpdateChecker } from "@/components/app-update-checker";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "IssueDeck",
  description: "複数のGitHubリポジトリのIssueを横断して確認・整理できるWebアプリ",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "IssueDeck",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // スマホ（特にiOS Safari・ホーム画面アプリ）では、overflow-hiddenだけでは
    // ドキュメント自体のラバーバンドスクロールを止められず、指でスクロールすると
    // アプリシェルごと上下に動いてヘッダー・フッターが固定されていないように見える（#607）。
    // overscroll-none（overscroll-behavior: none）でバウンス・引っ張って更新を無効化し、
    // bodyをfixed inset-0でビューポートに固定して、ドキュメントが一切動かないようにする。
    //
    // bodyのh-full（height: 100%）はfixed inset-0と重複して見えるが、外さないこと（#2263）。
    // Radixのダイアログ・セレクトを開いている間、react-remove-scrollが
    // `body[data-scroll-locked] { position: relative !important }`をbodyへ当てる。高さを
    // inset-0＋fixedだけで決めていると、positionが書き換わった時点でbodyの高さがauto（中身の高さ）に
    // なり、h-full→flex-1＋min-h-0で組んだ画面の高さの連鎖が全部ほどける。Issue一覧などの
    // スクロール領域が中身の高さまで伸びてスクロール不能になり、その瞬間にブラウザがscrollTopを
    // 0へ落とすため、モーダルを閉じたあと一覧が先頭に戻ってしまう。height: 100%はhtml（h-full）の
    // 100%＝ビューポート高に解決され、fixed時の高さと同じ値になるので、positionが書き換わっても
    // 高さが定まったままになる。
    <html
      lang="ja"
      className={`${geistMono.variable} h-full overflow-x-hidden overscroll-none antialiased`}
    >
      <body className="fixed inset-0 h-full flex flex-col overflow-hidden overscroll-none">
        {children}
        <AppUpdateChecker currentVersion={packageJson.version} />
      </body>
    </html>
  );
}
