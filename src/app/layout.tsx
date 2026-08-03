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
    <html
      lang="ja"
      className={`${geistMono.variable} h-full overflow-x-hidden antialiased`}
    >
      <body className="h-full flex flex-col overflow-hidden">
        {children}
        <AppUpdateChecker currentVersion={packageJson.version} />
      </body>
    </html>
  );
}
