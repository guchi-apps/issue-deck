"use client";

import { Loader2, Mic } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIssueBodyCleanup } from "@/hooks/use-issue-body-cleanup";
import { cn } from "@/lib/utils";

type BodyCleanupButtonProps = {
  /** 整形の対象となる現在の入力値 */
  value: string;
  /** 整形が成功したときに、整形後のテキストを受け取る */
  onCleaned: (text: string) => void;
  /** 送信中など、入力欄ごと操作させたくない場合に立てる */
  disabled?: boolean;
  /** 外側のラッパーに付与するクラス */
  className?: string;
  /**
   * 1行目にアイコン・2〜3行目に「音声／整理」の3行に組む（#3054）。「画像を添付」と
   * 同じ行へ並べるときに、横幅を詰めて同じ行のサムネイルの欄を広げるために使う。
   * 読み上げ・ホバーの名前は変えない
   */
  stacked?: boolean;
};

/**
 * 音声入力で書き起こした文章のノイズ（フィラー・言い淀み等）をClaudeに整形させるボタン。
 * 本文・コメント・質問など複数の入力欄で使うため、状態（生成中・エラー・トークン未設定）の
 * 保持と表示までをこのコンポーネントに閉じている（#1399）。
 */
export function BodyCleanupButton({
  value,
  onCleaned,
  disabled,
  className,
  stacked,
}: BodyCleanupButtonProps) {
  const { isGenerating, error, notConfigured, generate } = useIssueBodyCleanup();

  async function handleCleanup() {
    const result = await generate(value);
    if (!result) return;
    onCleaned(result.text);
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Button
        type="button"
        variant="outline"
        size="xs"
        // mdの高さ（md:h-6）はsizeの側にあるので、md:h-12も足して打ち消す
        className={cn("w-fit", stacked && "h-12 flex-col gap-0.5 px-2 md:h-12 md:px-2")}
        disabled={!value.trim() || isGenerating || disabled}
        onClick={handleCleanup}
        aria-label={stacked ? "音声入力を整理" : undefined}
        title={stacked ? "音声入力を整理" : undefined}
      >
        {isGenerating ? <Loader2 className="animate-spin" /> : <Mic />}
        {stacked ? (
          <span className="text-center leading-tight">
            音声
            <br />
            整理
          </span>
        ) : (
          "音声入力を整理"
        )}
      </Button>
      {notConfigured && (
        <p className="text-xs text-muted-foreground">選択したAIモデルの認証情報が設定されていません</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
