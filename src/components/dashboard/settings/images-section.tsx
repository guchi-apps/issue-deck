"use client";

import { useState } from "react";
import { X } from "lucide-react";

import {
  ImagePreviewDialog,
  type ImagePreviewTarget,
} from "@/components/dashboard/image-preview-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useUploadedImages } from "@/hooks/use-uploaded-images";
import { formatDateTime } from "@/lib/format-date-time";
import { formatUploadedImageSize } from "@/lib/uploaded-images";
import type { UploadedImage } from "@/types/uploaded-image";

/** 最初に出す枚数と「さらに表示」1回ぶんの枚数 */
const VISIBLE_STEP = 24;

/**
 * アップロード済み画像の一覧と削除（#2462）。
 *
 * Issue・コメントに添付した画像はVPSの`uploads/images/`へ残り続け、これまで画面からも
 * APIからも消す手段が無かった。人に見られたくない画像を後から消せるようにするための区分。
 *
 * **一覧はサムネイルだけで、貼り付け先のIssueは出さない。** 画像に持ち主や貼り付け先の
 * 記録が無く、コメント本文もDBに持っていないため、「未使用」を正しく判定できない。
 * 誤って「未使用」と出すと消してよいと読めてしまうので、判断材料は見た目の絵に寄せ、
 * 取り消せないことは確認ダイアログで伝える。
 *
 * **サムネイルは原本をそのまま縮めて出している。** 配信APIに縮小版を作る経路が無く、
 * 1枚あたり10MBまで受け付けるため、全件をいちどに並べるとスマホの回線で重くなる。
 * `loading="lazy"`に加えて表示件数を`VISIBLE_STEP`ずつに区切り、「さらに表示」で伸ばす
 * （一覧APIは全件を返すので、古い画像が消せなくなることはない）。
 */
export function ImagesSection() {
  const { images, isLoading, error, deleteImage, deletingFilename } = useUploadedImages();
  const [preview, setPreview] = useState<ImagePreviewTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UploadedImage | null>(null);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const { filename } = deleteTarget;
    setDeleteTarget(null);
    await deleteImage(filename);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Issueやコメントに添付した画像です。×を押すとサーバーから削除します。
      </p>

      {isLoading && images === null && (
        <p className="text-xs text-muted-foreground">読み込み中...</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {images && images.length === 0 && (
        <p className="text-xs text-muted-foreground">アップロードされた画像はありません</p>
      )}

      {images && images.length > 0 && (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {images.slice(0, visibleCount).map((image) => (
            <li key={image.filename} className="flex min-w-0 flex-col gap-1">
              <div className="relative">
                <button
                  type="button"
                  aria-label={`${image.filename} を拡大する`}
                  onClick={() => setPreview({ src: image.url, name: image.filename })}
                  className="block aspect-square w-full overflow-hidden rounded-lg border bg-muted"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                  />
                </button>
                <button
                  type="button"
                  aria-label={`${image.filename} を削除する`}
                  disabled={deletingFilename !== null}
                  onClick={() => setDeleteTarget(image)}
                  className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full border bg-background text-muted-foreground shadow-xs transition-colors hover:bg-destructive hover:text-white disabled:opacity-50"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="truncate text-[11px] text-muted-foreground">
                {formatDateTime(image.uploadedAt)} · {formatUploadedImageSize(image.size)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {images && images.length > visibleCount && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setVisibleCount((count) => count + VISIBLE_STEP)}
        >
          さらに表示（残り{images.length - visibleCount}枚）
        </Button>
      )}

      <ImagePreviewDialog image={preview} onClose={() => setPreview(null)} />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>この画像を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              サーバー上の原本を削除します。この操作は取り消せません。ただし、すでに画像を開いた画面やGitHub側のIssue画面では、それぞれのキャッシュが切れるまで表示が残ることがあります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTarget && (
            <div className="grid place-items-center rounded-lg border bg-muted p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={deleteTarget.url}
                alt={`${deleteTarget.filename} のプレビュー`}
                className="max-h-40 max-w-full rounded-md object-contain"
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>削除する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
