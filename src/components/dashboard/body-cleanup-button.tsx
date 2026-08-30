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
        className="w-fit"
        disabled={!value.trim() || isGenerating || disabled}
        onClick={handleCleanup}
      >
        {isGenerating ? <Loader2 className="animate-spin" /> : <Mic />}
        音声入力を整理
      </Button>
      {notConfigured && (
        <p className="text-xs text-muted-foreground">選択したAIモデルの認証情報が設定されていません</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
