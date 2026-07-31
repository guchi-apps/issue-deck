import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
// Murechoは@fontsourceパッケージ（npm経由でフォントファイル本体を配布）で自己ホストする。
// next/font/googleのCJKフォントはこの開発環境から fonts.gstatic.com に到達できずビルドが失敗するため使わない。
import "@fontsource/murecho/400.css";
import "@fontsource/murecho/500.css";
import "@fontsource/murecho/600.css";
import "@fontsource/murecho/700.css";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "IssueDeck",
  description: "複数のGitHubリポジトリのIssueを横断して確認・整理できるWebアプリ",
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
      className={`${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
