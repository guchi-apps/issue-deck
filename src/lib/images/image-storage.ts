import { mkdir, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";

import { isUploadedImageFilename, type UploadedImageFile } from "@/lib/uploaded-images";

/**
 * 添付画像の置き場（#2462・#2475）。**パスの正はここ1か所**で、アップロード・配信・削除・
 * 巡回がここから読む（以前は受け口ごとに`path.join`を写していた）。
 *
 * `uploads/`は`.gitignore`済みで配布物にも入らず、`deploy.yml`のクリーンアップ対象にも
 * 入っていないため本番で永続する。**`deploy.yml`の`rm -rf`の行に`uploads`を足すと
 * ユーザーがアップロードした画像が消える。**
 */
export const UPLOADED_IMAGE_DIR = path.join(process.cwd(), "uploads", "images");

/**
 * 自動削除がいったん退避させる先（#2475）。
 *
 * **画像の置き場の中に置く。** 一覧（`readdir`）はディレクトリを`isFile()`で弾き、配信は
 * UUID形式でないファイル名を404にするので、既存の受け口を直さずに共存できる。
 * ドットで始めているのは、手でディレクトリを覗いたときに画像と紛れないようにするため。
 */
export const UPLOADED_IMAGE_TRASH_DIR = path.join(UPLOADED_IMAGE_DIR, ".trash");

/**
 * ディレクトリの中身をファイル1件ずつの情報にして返す。
 *
 * ディレクトリが無い環境（1枚もアップロードしていない・ゴミ箱が空）では空配列を返す。
 * アップロードAPIが作った名前でないもの（手で置いたファイル・`.trash`ディレクトリ自身）は
 * ここで落とす。
 */
async function readImageDir(dir: string): Promise<UploadedImageFile[]> {
  const filenames = await readdir(dir).catch(() => null);
  if (!filenames) return [];

  const files: UploadedImageFile[] = [];
  for (const filename of filenames) {
    if (!isUploadedImageFilename(filename)) continue;
    const stats = await stat(path.join(dir, filename)).catch(() => null);
    if (!stats?.isFile()) continue;
    files.push({ filename, size: stats.size, modifiedAtMs: stats.mtimeMs });
  }
  return files;
}

export function readUploadedImageFiles(): Promise<UploadedImageFile[]> {
  return readImageDir(UPLOADED_IMAGE_DIR);
}

/**
 * ゴミ箱の中身。`modifiedAtMs`は**ゴミ箱へ移した時刻**になる（`rename`ではmtimeが変わらない
 * ため、移すときに明示的に触っている。`moveImagesToTrash`を参照）。
 */
export function readTrashedImageFiles(): Promise<UploadedImageFile[]> {
  return readImageDir(UPLOADED_IMAGE_TRASH_DIR);
}

/** 移した枚数と、そのバイト数の合計 */
export type ImageMoveResult = {
  filenames: string[];
  size: number;
};

/**
 * ゴミ箱へ移す。**同じファイルシステム内の`rename`なので中身は書き換わらない。**
 *
 * 移した時刻を`mtime`に載せ直しているのは、ゴミ箱の滞在期間（＝完全に削除するまでの猶予）を
 * その1つで測るため。`rename`はmtimeを引き継ぐので、そのままだとアップロード時刻のままになり、
 * 古い画像が移した瞬間に完全削除の条件を満たしてしまう。
 */
export async function moveImagesToTrash(filenames: string[]): Promise<ImageMoveResult> {
  if (filenames.length === 0) return { filenames: [], size: 0 };
  await mkdir(UPLOADED_IMAGE_TRASH_DIR, { recursive: true });

  const moved: string[] = [];
  let size = 0;
  const now = new Date();
  for (const filename of filenames) {
    if (!isUploadedImageFilename(filename)) continue;
    const from = path.join(UPLOADED_IMAGE_DIR, filename);
    const to = path.join(UPLOADED_IMAGE_TRASH_DIR, filename);
    const stats = await stat(from).catch(() => null);
    if (!stats?.isFile()) continue;
    try {
      await rename(from, to);
      await utimes(to, now, now).catch(() => undefined);
      moved.push(filename);
      size += stats.size;
    } catch (error) {
      console.error("[moveImagesToTrash]", filename, error);
    }
  }
  return { filenames: moved, size };
}

/** ゴミ箱から元へ戻す。ゴミ箱に入れた後で参照が見つかった画像に使う */
export async function restoreImagesFromTrash(filenames: string[]): Promise<ImageMoveResult> {
  if (filenames.length === 0) return { filenames: [], size: 0 };
  await mkdir(UPLOADED_IMAGE_DIR, { recursive: true });

  const restored: string[] = [];
  let size = 0;
  for (const filename of filenames) {
    if (!isUploadedImageFilename(filename)) continue;
    const from = path.join(UPLOADED_IMAGE_TRASH_DIR, filename);
    const to = path.join(UPLOADED_IMAGE_DIR, filename);
    const stats = await stat(from).catch(() => null);
    if (!stats?.isFile()) continue;
    try {
      await rename(from, to);
      restored.push(filename);
      size += stats.size;
    } catch (error) {
      console.error("[restoreImagesFromTrash]", filename, error);
    }
  }
  return { filenames: restored, size };
}

/** ゴミ箱から完全に削除する。ここから先は戻せない */
export async function purgeTrashedImages(filenames: string[]): Promise<ImageMoveResult> {
  const purged: string[] = [];
  let size = 0;
  for (const filename of filenames) {
    if (!isUploadedImageFilename(filename)) continue;
    const target = path.join(UPLOADED_IMAGE_TRASH_DIR, filename);
    const stats = await stat(target).catch(() => null);
    if (!stats?.isFile()) continue;
    try {
      await unlink(target);
      purged.push(filename);
      size += stats.size;
    } catch (error) {
      console.error("[purgeTrashedImages]", filename, error);
    }
  }
  return { filenames: purged, size };
}
