"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, ScanText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIssueImageExtract } from "@/hooks/use-issue-image-extract";
import { formatExtractedChanges } from "@/lib/image-extract-format";
import { appendToBody, splitAttachments } from "@/lib/markdown-attachments";

type ImageExtractButtonProps = {
  /** 添付画像（末尾の画像記法）を含む、入力欄の現在の値 */
  value: string;
  /** 抽出した変更内容を本文の末尾へ足した、新しい値を受け取る */
  onChange: (value: string) => void;
  /** 送信中など、入力欄ごと操作させたくない場合に立てる */
  disabled?: boolean;
};

/**
 * 添付画像に書き込まれた記号・文字から変更内容をAIに読み取らせ、本文の末尾へ足すボタン（#3243）。
 *
 * **押したときだけ読む。** 呼び出しごとにプラン枠を消費するため、添付・書き込み保存のたびの
 * 自動実行にはしない。読み取り結果は本文へ足すだけで、確定は押した人が入力欄で直して決める。
 *
 * **フラグメントで返す**——状態の文は`basis-full`で折り返し、親の`flex-wrap`な行の次の段へ
 * 全幅で出す（見出し・ボタンの並びは崩さない）。親は`flex flex-wrap`にすること。
 */
export function ImageExtractButton({ value, onChange, disabled }: ImageExtractButtonProps) {
  const { isExtracting, error, notConfigured, extract } = useIssueImageExtract();
  const [addedCount, setAddedCount] = useState<number | null>(null);
  const [unreadable, setUnreadable] = useState(false);

  // 読み取りには数秒かかる。その間に本文を直されても上書きしないよう、書き戻すときは最新の値を読む。
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const imageUrls = splitAttachments(value).attachments.map((attachment) => attachment.url);
  const imageCount = imageUrls.length;

  async function handleExtract() {
    setAddedCount(null);
    const result = await extract(imageUrls);
    if (!result) return;
    const text = formatExtractedChanges(result);
    if (!text) return;
    onChange(appendToBody(valueRef.current, text));
    setAddedCount(result.items.length);
    setUnreadable(result.unreadable);
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="w-fit"
        disabled={imageCount === 0 || isExtracting || disabled}
        onClick={handleExtract}
      >
        {isExtracting ? <Loader2 className="animate-spin" /> : <ScanText />}
        {isExtracting ? "読み取り中" : "画像から変更内容を抽出"}
      </Button>
      {isExtracting && (
        <p role="status" className="basis-full text-xs text-muted-foreground">
          画像{imageCount}枚を読み取っています…
        </p>
      )}
      {!isExtracting && addedCount !== null && !error && (
        <p role="status" className="flex basis-full items-start gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {addedCount}件の変更内容を本文へ追加しました
            {unreadable ? "（判読できない書き込みあり）" : ""}。読み取りの誤りは入力欄で直してください。
          </span>
        </p>
      )}
      {notConfigured && (
        <p className="basis-full text-xs text-muted-foreground">選択したAIモデルの認証情報が設定されていません</p>
      )}
      {error && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
