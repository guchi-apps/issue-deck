"use client";

import { AppIconGlyph } from "@/lib/app-icon-glyph";
import { Button } from "@/components/ui/button";

type AppErrorScreenProps = {
  /** Next.jsがエラー画面へ渡す識別子。原因を追うときの手がかりとして小さく出す。 */
  digest?: string;
  /** もう一度描画し直す。`error.tsx`の`reset`をそのまま渡す。 */
  onRetry: () => void;
};

/**
 * 画面を読み込めなかったときに出す全画面のエラー画面（#1978）。
 *
 * これまではエラーの受け（`error.tsx`）が無く、Next.jsの既定の英語の画面になるか、
 * 白いまま止まっていた。ホーム画面から起動したPWAでは、それが「読み込みが遅いだけ」なのか
 * 「もう終わっている」のかを区別できない。`AppLoadingScreen`と同じ並び・同じ位置のまま
 * 文言と操作だけを差し替え、待っても進まないことがひと目で分かるようにする。
 */
export function AppErrorScreen({ digest, onRetry }: AppErrorScreenProps) {
  return (
    <div
      role="alert"
      className="flex h-full flex-1 flex-col items-center justify-center gap-4 bg-background p-6 text-center"
    >
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
        <AppIconGlyph size={30} fill="var(--muted-foreground)" />
      </div>
      <p className="text-lg font-semibold">読み込めませんでした</p>
      <p className="max-w-[34ch] text-sm text-muted-foreground">
        画面の読み込みに失敗しました。通信の状況を確かめて、もう一度お試しください。
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRetry}>
          再試行
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            window.location.href = "/login";
          }}
        >
          ログイン画面へ
        </Button>
      </div>
      {digest && <p className="font-mono text-xs text-muted-foreground">{digest}</p>}
    </div>
  );
}
