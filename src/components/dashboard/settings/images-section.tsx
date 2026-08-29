"use client";

import { useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";

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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUploadedImages } from "@/hooks/use-uploaded-images";
import { IMAGE_RETENTION_DAYS_OPTIONS } from "@/lib/app-settings";
import { formatDateTime } from "@/lib/format-date-time";
import {
  formatUploadedImageSize,
  formatUploadedImageTotal,
  selectCleanupTargets,
  totalUploadedImageSize,
} from "@/lib/uploaded-images";
import { cn } from "@/lib/utils";
import type { UploadedImage, UploadedImageUsage } from "@/types/uploaded-image";

/** 最初に出す枚数と「さらに表示」1回ぶんの枚数 */
const VISIBLE_STEP = 24;

type Filter = "all" | "used" | "unused";

/**
 * アップロード済み画像の容量・使用状況・削除（#2462・#2475）。
 *
 * **「未使用」は推定ではなく、実際に本文とコメントを読んだ結果だけを出す。** 参照の索引
 * （`UploadedImageReference`）を巡回が作るまでは判定できないため、一巡し終わるまでは
 * `未使用`ではなく`確認中`と出し、削除の対象にも数えない。誤って「未使用」と出すと
 * 消してよいと読めてしまう。
 *
 * **どこを見ていないかを画面にも書く。** 見ているのはIssue本文とIssue／PRのコメントだけで、
 * PR本文・リポジトリ内のファイル・GitHub外への貼り付けは見えない。ここを黙っていると
 * 「未使用＝安全に消せる」と読まれる。
 *
 * **サムネイルは原本をそのまま縮めて出している。** 配信APIに縮小版を作る経路が無く、
 * 1枚あたり10MBまで受け付けるため、全件をいちどに並べるとスマホの回線で重くなる。
 * `loading="lazy"`に加えて表示件数を`VISIBLE_STEP`ずつに区切り、「さらに表示」で伸ばす。
 */
export function ImagesSection() {
  const {
    images,
    summary,
    scan,
    cleanup,
    isLoading,
    error,
    deleteImage,
    deletingFilename,
    runCleanup,
    updateCleanupSettings,
    isBusy,
  } = useUploadedImages();
  const [preview, setPreview] = useState<ImagePreviewTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UploadedImage | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<"trash-unused" | "empty-trash" | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEP);

  const cleanupTargets = useMemo(() => {
    if (!images || !cleanup || !scan) return [];
    return selectCleanupTargets(images, {
      retentionDays: cleanup.retentionDays,
      scanCompletedAt: scan.completedAt,
      now: new Date(),
    });
  }, [images, cleanup, scan]);

  const visibleImages = useMemo(() => {
    if (!images) return [];
    if (filter === "all") return images;
    return images.filter((image) => image.usage === filter);
  }, [images, filter]);

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const { filename } = deleteTarget;
    setDeleteTarget(null);
    await deleteImage(filename);
  }

  async function handleConfirmBulk() {
    const mode = confirmBulk;
    setConfirmBulk(null);
    if (mode) await runCleanup(mode);
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

      {summary && (
        <section className="flex flex-col gap-2.5 rounded-lg border p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[13px] font-semibold">使用中の容量</h3>
            <span className="text-xs tabular-nums text-muted-foreground">
              {summary.total.count}枚
            </span>
          </div>

          <p className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-2xl leading-none font-bold tracking-tight">
              {formatUploadedImageTotal(summary.total.size)}
            </span>
          </p>

          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
            <span
              className="block bg-emerald-600 dark:bg-emerald-400"
              style={{ width: `${ratio(summary.used.size, summary.total.size)}%` }}
            />
            <span
              className="block bg-amber-500 dark:bg-amber-400"
              style={{ width: `${ratio(summary.unused.size, summary.total.size)}%` }}
            />
            <span
              className="block bg-muted-foreground/45"
              style={{ width: `${ratio(summary.unknown.size, summary.total.size)}%` }}
            />
            <span
              className="block bg-muted-foreground/70"
              style={{ width: `${ratio(summary.trashed.size, summary.total.size)}%` }}
            />
          </div>

          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
            <LegendItem
              className="bg-emerald-600 dark:bg-emerald-400"
              label="使用中"
              count={summary.used.count}
              size={summary.used.size}
            />
            <LegendItem
              className="bg-amber-500 dark:bg-amber-400"
              label="未使用"
              count={summary.unused.count}
              size={summary.unused.size}
            />
            {summary.unknown.count > 0 && (
              <LegendItem
                className="bg-muted-foreground/45"
                label="確認中"
                count={summary.unknown.count}
                size={summary.unknown.size}
              />
            )}
            {summary.trashed.count > 0 && (
              <LegendItem
                className="bg-muted-foreground/70"
                label="ゴミ箱"
                count={summary.trashed.count}
                size={summary.trashed.size}
              />
            )}
          </ul>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            「使用中」はIssueの本文とIssue・PRのコメントから参照が見つかったものです。
            <strong className="font-semibold">
              PRの本文・リポジトリ内のファイル・issue-deck以外へ貼った分は見ていません。
            </strong>
          </p>
        </section>
      )}

      {cleanup && scan && (
        <section className="flex flex-col gap-2.5 rounded-lg border p-3">
          <label className="flex items-start gap-2 text-[13px] font-medium">
            <Checkbox
              checked={cleanup.enabled}
              disabled={isBusy}
              onCheckedChange={(checked) =>
                void updateCleanupSettings({ enabled: checked === true })
              }
              className="mt-0.5 shrink-0"
            />
            <span>未使用の画像を自動でゴミ箱へ移す</span>
          </label>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            参照が見つからない画像をゴミ箱へ移し、ゴミ箱で{cleanup.trashDays}
            日が過ぎたら完全に削除します。ゴミ箱にある間に参照が見つかれば元に戻します。
          </p>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>アップロードから</span>
            <Select
              value={String(cleanup.retentionDays)}
              disabled={isBusy}
              onValueChange={(value) =>
                void updateCleanupSettings({
                  enabled: cleanup.enabled,
                  retentionDays: Number(value),
                })
              }
            >
              <SelectTrigger size="sm" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IMAGE_RETENTION_DAYS_OPTIONS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {days}日
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span>経過したものを対象にする</span>
          </div>

          {scan.completedAt === null ? (
            <p className="rounded-md bg-muted px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <strong className="font-semibold">
                参照の確認中です（{scan.scannedRepositoryCount} / {scan.repositoryCount}
                リポジトリ）。
              </strong>
              すべてのIssueとコメントを一度確認し終えるまで、自動削除は始まりません。
            </p>
          ) : (
            <>
              {cleanup.enabled && cleanupTargets.length > 0 && (
                <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
                  次の巡回で{" "}
                  <strong className="font-semibold tabular-nums">
                    {cleanupTargets.length}枚（
                    {formatUploadedImageTotal(totalUploadedImageSize(cleanupTargets))}）
                  </strong>{" "}
                  をゴミ箱へ移します。
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                参照の確認: {formatDateTime(scan.completedAt)}時点（{scan.repositoryCount}
                リポジトリ）
              </p>
            </>
          )}

          {summary && summary.trashed.count > 0 && (
            <div className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
              <span>
                ゴミ箱に{" "}
                <strong className="font-semibold text-foreground">
                  {summary.trashed.count}枚（{formatUploadedImageTotal(summary.trashed.size)}）
                </strong>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                className="ml-auto"
                onClick={() => setConfirmBulk("empty-trash")}
              >
                ゴミ箱を空にする
              </Button>
            </div>
          )}
        </section>
      )}

      {images && images.length === 0 && (
        <p className="text-xs text-muted-foreground">アップロードされた画像はありません</p>
      )}

      {images && images.length > 0 && summary && (
        <div className="flex flex-wrap items-center gap-2">
          <FilterTab
            value="all"
            current={filter}
            label="すべて"
            count={summary.total.count - summary.trashed.count}
            onSelect={setFilter}
          />
          <FilterTab
            value="used"
            current={filter}
            label="使用中"
            count={summary.used.count}
            onSelect={setFilter}
          />
          <FilterTab
            value="unused"
            current={filter}
            label="未使用"
            count={summary.unused.count}
            onSelect={setFilter}
          />
          {cleanupTargets.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              className="ml-auto text-destructive"
              onClick={() => setConfirmBulk("trash-unused")}
            >
              未使用{cleanupTargets.length}枚をゴミ箱へ
            </Button>
          )}
        </div>
      )}

      {visibleImages.length > 0 && (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {visibleImages.slice(0, visibleCount).map((image) => (
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
                <UsageBadge image={image} />
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

      {images && images.length > 0 && visibleImages.length === 0 && (
        <p className="text-xs text-muted-foreground">この条件に当てはまる画像はありません</p>
      )}

      {visibleImages.length > visibleCount && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setVisibleCount((count) => count + VISIBLE_STEP)}
        >
          さらに表示（残り{visibleImages.length - visibleCount}枚）
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

      <AlertDialog
        open={confirmBulk !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmBulk(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmBulk === "empty-trash"
                ? "ゴミ箱を空にしますか？"
                : `未使用の${cleanupTargets.length}枚をゴミ箱へ移しますか？`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmBulk === "empty-trash"
                ? "ゴミ箱の中の原本をすべて削除します。この操作は取り消せません。"
                : "参照が見つからず、保持期間を過ぎた画像をゴミ箱へ移します。ゴミ箱にある間は元に戻せますが、PRの本文やissue-deck以外へ貼った画像は「未使用」に見えている点に注意してください。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmBulk}>
              {confirmBulk === "empty-trash" ? "空にする" : "ゴミ箱へ移す"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ratio(size: number, total: number): number {
  if (total <= 0) return 0;
  return (size / total) * 100;
}

function LegendItem({
  className,
  label,
  count,
  size,
}: {
  className: string;
  label: string;
  count: number;
  size: number;
}) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-full", className)} />
      <span>
        {label} <strong className="font-semibold text-foreground">{count}枚</strong> /{" "}
        {formatUploadedImageTotal(size)}
      </span>
    </li>
  );
}

const FILTER_LABEL: Record<UploadedImageUsage, string> = {
  used: "使用中",
  unused: "未使用",
  unknown: "確認中",
};

function FilterTab({
  value,
  current,
  label,
  count,
  onSelect,
}: {
  value: Filter;
  current: Filter;
  label: string;
  count: number;
  onSelect: (value: Filter) => void;
}) {
  const isActive = value === current;
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={() => onSelect(value)}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs tabular-nums transition-colors",
        isActive
          ? "border-primary bg-primary font-medium text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label} {count}
    </button>
  );
}

/**
 * サムネイルの左下に出す使用状況の印。
 *
 * 使用中のときは**GitHubのIssue／PRを別タブで開くリンク**にする。参照はIssue番号でしか
 * 持っておらず（コメント一覧はPRのコメントも返すので、issue-deck側に対応する行が無いことが
 * ある）、アプリ内の詳細を確実に開けないため。
 */
function UsageBadge({ image }: { image: UploadedImage }) {
  if (image.usage === "unknown") {
    return (
      <span className="absolute bottom-1 left-1 rounded-full border bg-background/90 px-1.5 text-[10px] leading-4 font-semibold text-muted-foreground">
        確認中
      </span>
    );
  }

  if (image.usage === "unused") {
    return (
      <span className="absolute bottom-1 left-1 rounded-full border border-amber-300 bg-amber-50 px-1.5 text-[10px] leading-4 font-semibold text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400">
        {FILTER_LABEL.unused}
      </span>
    );
  }

  const [first, ...rest] = image.references;
  if (!first) return null;
  const href = `https://github.com/${first.repositoryFullName}/${first.isPullRequest ? "pull" : "issues"}/${first.issueNumber}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={image.references
        .map((ref) => `${ref.repositoryFullName}#${ref.issueNumber}`)
        .join("\n")}
      className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded-full border border-emerald-300 bg-emerald-50 px-1.5 text-[10px] leading-4 font-semibold text-emerald-700 hover:underline dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400"
    >
      #{first.issueNumber}
      {rest.length > 0 && ` +${rest.length}`}
      <ExternalLink className="size-2.5" />
    </a>
  );
}
