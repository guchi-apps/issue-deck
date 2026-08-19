"use client";

import "./globals.css";

import { AppErrorScreen } from "@/components/app-error-screen";

/**
 * ルートレイアウトごと落ちたときの受け（#1978）。この場合は`layout.tsx`が描画されないため、
 * html・bodyとスタイルの読み込みをここが自前で持つ。フォント（@fontsource）は読み込まず、
 * OS標準のフォントで出す——落ちている最中に読むものを増やさない。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ja" className="h-full">
      <body className="flex h-full flex-col bg-background text-foreground">
        <AppErrorScreen digest={error.digest} onRetry={reset} />
      </body>
    </html>
  );
}
