"use client";

import { ExternalLink, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { useHistoryDismiss } from "@/hooks/use-history-dismiss";

/** プレビューで開いている画像。閉じているときは`null` */
export type ImagePreviewTarget = {
  src: string;
  /** 画像の名前（Markdownの代替テキスト＝添付時のファイル名）。空でもよい */
  name: string;
};

/**
 * 添付画像の原寸プレビュー（#2065）。
 *
 * 以前は原寸を`target="_blank"`で別タブに開いていた。ホーム画面から起動したアプリ
 * （`display: standalone`）にはタブもアドレスバーも無く、開いた画像を閉じて元の画面へ戻る
 * 導線が画面のどこにも無かったため、アプリの中に重ねて開く形にしてバツボタンを付ける。
 *
 * 閉じ方は4つ（バツボタン・画像の外側・Escキー・スマホの戻る操作）。Escと外側の判定は
 * Radixに任せず、**画像の外側のクリックはこの中で拾う**——重ね表示は全画面なので、
 * Radixの「Contentの外側」判定に当たる領域が存在しない。
 *
 * 別タブで開く導線は下辺のリンクとして残す。ブラウザで見ている場合は、画像を単体で
 * 開いてOSの機能で保存・共有できる方が早い。
 */
export function ImagePreviewDialog({
  image,
  onClose,
}: {
  image: ImagePreviewTarget | null;
  onClose: () => void;
}) {
  const open = image !== null;
  useHistoryDismiss(open, onClose);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          data-slot="image-preview"
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          <DialogPrimitive.Title className="sr-only">
            {image?.name ? `${image.name} のプレビュー` : "画像のプレビュー"}
          </DialogPrimitive.Title>

          {/* 画像そのもの以外を押したら閉じる。paddingの余白もこの判定に含める。
              キーボード・支援技術からはEscとバツボタンで閉じるので、ここは操作を持たない */}
          <div
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              onClose();
            }}
            className="grid min-h-0 flex-1 cursor-zoom-out place-items-center px-4 pt-14 pb-2"
          >
            {image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image.src}
                alt={image.name}
                className="max-h-full max-w-full cursor-default rounded-md object-contain"
              />
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-1 pb-4 text-xs text-white/70">
            <span className="truncate">{image?.name}</span>
            {image && (
              <a
                href={image.src}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-white underline underline-offset-4"
              >
                新しいタブで開く
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>

          <DialogPrimitive.Close
            aria-label="プレビューを閉じる"
            className="absolute top-3 right-3 grid size-10 place-items-center rounded-full border border-white/30 bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
          >
            <X className="size-4.5" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
