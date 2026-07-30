import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

// 日本語の本文フォントはOS標準フォントのスタック（globals.cssの--font-sans）を使う。
// Google Fonts経由のCJKフォントはこの開発環境から fonts.gstatic.com に到達できず
// ビルドが失敗するため採用しない。
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "IssueDeck",
  description: "複数のGitHubリポジトリのIssueを横断して確認・整理できるWebアプリ",
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
