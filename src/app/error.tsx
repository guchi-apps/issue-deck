"use client";

import { AppErrorScreen } from "@/components/app-error-screen";

// 画面の描画に失敗したときの受け。これが無いとNext.js既定の英語の画面になり、
// ホーム画面から起動したPWAでは読み込み中との区別が付かない（#1978）。
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <AppErrorScreen digest={error.digest} onRetry={reset} />;
}
