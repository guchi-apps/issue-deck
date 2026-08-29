import { db } from "@/lib/db";
import {
  decideImageCleanup,
  decideTrashPurge,
  decideTrashRestore,
  imageCleanupSweepIntervalMinutes,
  imageTrashDays,
  isImageScanComplete,
  type ImageCleanupSkipReason,
} from "@/lib/images/image-cleanup";
import {
  collectCommentReferences,
  collectIssueBodyReferences,
  getReferencesByFilename,
} from "@/lib/images/image-references";
import {
  moveImagesToTrash,
  purgeTrashedImages,
  readTrashedImageFiles,
  readUploadedImageFiles,
  restoreImagesFromTrash,
} from "@/lib/images/image-storage";
import { buildUploadedImageList, summarizeUploadedImages } from "@/lib/uploaded-images";
import type {
  UploadedImageCleanupSettings,
  UploadedImageListResponse,
  UploadedImageScanState,
} from "@/types/uploaded-image";

/**
 * 参照されていない添付画像の後始末（#2475）のIO側。判定は
 * [`image-cleanup.ts`](./image-cleanup.ts)、参照の収集は
 * [`image-references.ts`](./image-references.ts)に閉じている。
 *
 * サブPCのpollerが1巡ごとに`POST /api/issues/images/cleanup-sweep`を叩き、**実際に巡回するかは
 * サーバー側が間隔で決める**（既存の巡回4本と同じ取り決め）。1回の巡回でやることは4つ。
 *
 * 1. 参照を集め直す（Issue本文はDBから、コメントはGitHubから差分で）
 * 2. ゴミ箱に入れた後で参照が見つかった画像を元へ戻す
 * 3. 参照が無く保持期間を過ぎた画像をゴミ箱へ移す
 * 4. ゴミ箱で猶予を過ぎた画像を完全に削除する
 *
 * **2が3より先。** 判定を間違えて移してしまった画像を、人が気付く前に自分で戻すための順序。
 */

/**
 * 前回の巡回時刻（プロセス内）。既存の巡回3本と同じ持ち方で、プロセスの再起動でリセットされる。
 * ここは削除が絡むが、間隔が短くなって困るのは「同じ判定をもう一度する」だけ（判定そのものは
 * 保持期間・ゴミ箱の猶予で決まるので、回数を増やしても消える対象は増えない）。
 */
let lastSweptAt: number | null = null;

/** テスト用。巡回の間隔判定をリセットする */
export function resetImageCleanupSweepState(): void {
  lastSweptAt = null;
}

export type ImageCleanupSweepResult = {
  /** 実際に巡回したか。間隔に達していない・無効化されている場合は`false` */
  swept: boolean;
  /** 読んだコメントの件数 */
  scannedComments?: number;
  /** 参照の索引が全リポジトリぶん一巡し終わっているか */
  scanCompleted?: boolean;
  /** ゴミ箱へ移した画像 */
  trashed?: { count: number; size: number };
  /** ゴミ箱から戻した画像 */
  restored?: { count: number; size: number };
  /** ゴミ箱から完全に削除した画像 */
  purged?: { count: number; size: number };
  /** 削除を見送った理由 */
  skipped?: ImageCleanupSkipReason | null;
};

export async function runImageCleanupSweep(
  options: { force?: boolean; full?: boolean } = {},
): Promise<ImageCleanupSweepResult> {
  const intervalMinutes = imageCleanupSweepIntervalMinutes();
  if (!options.force) {
    if (intervalMinutes === 0) return { swept: false };
    if (lastSweptAt !== null && Date.now() - lastSweptAt < intervalMinutes * 60_000) {
      return { swept: false };
    }
  }
  lastSweptAt = Date.now();

  const referenceCountBefore = await db.uploadedImageReference.count();

  await collectIssueBodyReferences();
  const commentScan = await collectCommentReferences({ full: options.full });

  const referenceCountAfter = await db.uploadedImageReference.count();

  const repositories = await db.repository.findMany({
    where: { archived: false },
    select: { imageCommentScanAt: true, lastSyncedAt: true },
  });
  const scanCompleted = isImageScanComplete({
    repositories,
    hasPendingPages: commentScan.pendingRepositories > 0,
    hasErrors: commentScan.failedRepositories > 0,
  });

  const settings = await getCleanupSettings();
  const now = new Date();
  // **一巡し終わった時刻は、一巡し終わったときだけ進める。** 巡回のたびに書くと、
  // 「その画像をアップロードした後に一度は全体を確かめた」という条件が意味を失う。
  const scanCompletedAt = scanCompleted
    ? await markScanCompleted(now)
    : await readScanCompletedAt();

  const referencesByFilename = await getReferencesByFilename();
  const referencedFilenames = new Set(referencesByFilename.keys());

  // 1. ゴミ箱に入れた後で参照が見つかったものを戻す
  const trashFiles = await readTrashedImageFiles();
  const restored = await restoreImagesFromTrash(
    decideTrashRestore({ trashFiles, referencedFilenames }),
  );

  // 2. 参照が無く保持期間を過ぎたものをゴミ箱へ移す
  const files = await readUploadedImageFiles();
  const decision = decideImageCleanup({
    files,
    referencedFilenames,
    enabled: settings.enabled,
    retentionDays: settings.retentionDays,
    scanCompletedAt,
    referenceCountBefore,
    referenceCountAfter,
    now,
  });
  const trashed = await moveImagesToTrash(decision.toTrash);

  // 3. ゴミ箱で猶予を過ぎたものを完全に削除する
  const remainingTrash = await readTrashedImageFiles();
  const purged = await purgeTrashedImages(
    decideTrashPurge({
      trashFiles: remainingTrash,
      referencedFilenames,
      trashDays: settings.trashDays,
      now,
    }),
  );

  return {
    swept: true,
    scannedComments: commentScan.scannedComments,
    scanCompleted,
    trashed: { count: trashed.filenames.length, size: trashed.size },
    restored: { count: restored.filenames.length, size: restored.size },
    purged: { count: purged.filenames.length, size: purged.size },
    skipped: decision.skipped,
  };
}

/**
 * 画面が押す「未使用をまとめてゴミ箱へ」「ゴミ箱を空にする」（#2475）。
 *
 * **未使用の判定は巡回と同じものを使う**——保持期間も「一巡し終わっているか」も同じ。
 * 人が押したときだけ緩めると、画面で消したものと巡回が消すものが食い違う。
 * 違うのは設定のON/OFFを見ないところだけ（押したこと自体が意思表示なので）。
 */
export async function runManualImageCleanup(
  mode: "trash-unused" | "empty-trash",
): Promise<{ count: number; size: number; skipped: ImageCleanupSkipReason | null }> {
  const settings = await getCleanupSettings();
  const now = new Date();

  if (mode === "empty-trash") {
    const trashFiles = await readTrashedImageFiles();
    const purged = await purgeTrashedImages(trashFiles.map((file) => file.filename));
    return { count: purged.filenames.length, size: purged.size, skipped: null };
  }

  const referencesByFilename = await getReferencesByFilename();
  const referencedFilenames = new Set(referencesByFilename.keys());
  const files = await readUploadedImageFiles();
  const referenceCount = await db.uploadedImageReference.count();

  const decision = decideImageCleanup({
    files,
    referencedFilenames,
    enabled: true,
    retentionDays: settings.retentionDays,
    scanCompletedAt: await readScanCompletedAt(),
    referenceCountBefore: referenceCount,
    referenceCountAfter: referenceCount,
    now,
  });
  const trashed = await moveImagesToTrash(decision.toTrash);
  return { count: trashed.filenames.length, size: trashed.size, skipped: decision.skipped };
}

/**
 * 設定の「画像」区分が読む一覧（#2462・#2475）。
 *
 * 画像そのものはファイル、貼り付け先はDBの索引から来る。ゴミ箱の中身は一覧には出さず、
 * 容量サマリーにだけ数える（消したのに空き容量が増えていないように見えるのを避けるため）。
 */
export async function getUploadedImageInventory(): Promise<UploadedImageListResponse> {
  const [files, trashFiles, referencesByFilename, settings, scan] = await Promise.all([
    readUploadedImageFiles(),
    readTrashedImageFiles(),
    getReferencesByFilename(),
    getCleanupSettings(),
    getScanState(),
  ]);

  const images = buildUploadedImageList(files, {
    referencesByFilename,
    scanCompleted: scan.completedAt !== null,
  });

  return {
    images,
    summary: summarizeUploadedImages(images, trashFiles),
    scan,
    cleanup: settings,
  };
}

export async function getCleanupSettings(): Promise<UploadedImageCleanupSettings> {
  const setting = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { imageCleanupEnabled: true, imageRetentionDays: true },
  });
  return {
    enabled: setting?.imageCleanupEnabled ?? false,
    retentionDays: setting?.imageRetentionDays ?? 30,
    trashDays: imageTrashDays(),
  };
}

async function getScanState(): Promise<UploadedImageScanState> {
  const [repositories, completedAt] = await Promise.all([
    db.repository.findMany({
      where: { archived: false },
      select: { imageCommentScanAt: true },
    }),
    readScanCompletedAt(),
  ]);

  return {
    completedAt: completedAt?.toISOString() ?? null,
    repositoryCount: repositories.length,
    scannedRepositoryCount: repositories.filter((repo) => repo.imageCommentScanAt !== null).length,
  };
}

async function readScanCompletedAt(): Promise<Date | null> {
  const setting = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { imageScanCompletedAt: true },
  });
  return setting?.imageScanCompletedAt ?? null;
}

async function markScanCompleted(now: Date): Promise<Date> {
  await db.appSetting.upsert({
    where: { id: 1 },
    create: { id: 1, imageScanCompletedAt: now },
    update: { imageScanCompletedAt: now },
  });
  return now;
}
