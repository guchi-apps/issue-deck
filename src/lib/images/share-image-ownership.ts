import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { UPLOADED_IMAGE_DIR } from "@/lib/images/image-storage";
import { extractUploadedImageFilenames, isSvgImageUrl, isUploadedImageFilename } from "@/lib/uploaded-images";

/**
 * 共有画面からアップロードした画像と利用者の対応（#5673）。起案後のAI判定は、**本人が共有トークンで
 * アップロードした画像だけ**を読む。本文は任意の文字列を受け付けるため、URLに書いてあることは
 * 読む資格にならない（画像のUUIDは公開リポジトリの本文に載る。#2967）。
 *
 * DBではなく画像の置き場の中の記録ファイルで持つ（中身は利用者ID。判定に使ったら消す短命なもの）。
 * ドット始まりのディレクトリなので、一覧・配信・掃除（`image-storage.ts`）には出てこない。
 */
export const SHARE_IMAGE_OWNER_DIR = path.join(UPLOADED_IMAGE_DIR, ".share-owners");

const OWNER_RECORD_TTL_MS = 24 * 60 * 60_000;
/** AIへ送る画像の上限。消費は枚数に比例するため絞る */
const MAX_SHARE_AI_IMAGES = 3;
/** 1枚あたりの上限。Anthropic APIが受け付ける画像の上限（5MB） */
const MAX_SHARE_AI_IMAGE_BYTES = 5 * 1024 * 1024;

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export type ShareAiImage = { filename: string; mediaType: string; data: string };

function isExpired(modifiedAtMs: number): boolean {
  return Date.now() - modifiedAtMs > OWNER_RECORD_TTL_MS;
}

/** 起案まで至らなかったアップロードの記録を消す */
async function pruneExpiredRecords(): Promise<void> {
  for (const name of await readdir(SHARE_IMAGE_OWNER_DIR)) {
    const target = path.join(SHARE_IMAGE_OWNER_DIR, name);
    const stats = await stat(target).catch(() => null);
    if (stats && isExpired(stats.mtimeMs)) await rm(target, { force: true });
  }
}

export async function recordShareImageUpload(userId: string, filename: string): Promise<void> {
  if (!isUploadedImageFilename(filename)) return;
  await mkdir(SHARE_IMAGE_OWNER_DIR, { recursive: true });
  await pruneExpiredRecords().catch(() => undefined);
  await writeFile(path.join(SHARE_IMAGE_OWNER_DIR, filename), userId);
}

async function loadOwnedImage(userId: string, filename: string): Promise<ShareAiImage | null> {
  const record = path.join(SHARE_IMAGE_OWNER_DIR, filename);
  const [owner, recordStats] = await Promise.all([
    readFile(record, "utf8").catch(() => null),
    stat(record).catch(() => null),
  ]);
  if (owner !== userId || !recordStats || isExpired(recordStats.mtimeMs)) return null;

  const buffer = await readFile(path.join(UPLOADED_IMAGE_DIR, filename)).catch(() => null);
  if (!buffer || buffer.byteLength > MAX_SHARE_AI_IMAGE_BYTES) return null;

  const extension = filename.slice(filename.lastIndexOf(".") + 1);
  return { filename, mediaType: MEDIA_TYPE_BY_EXTENSION[extension], data: buffer.toString("base64") };
}

/** 本文に貼られた画像のうち、この利用者が共有画面から上げたものを読む。SVG・大きすぎるものは除く */
export async function loadOwnedShareImages(userId: string, body: string): Promise<ShareAiImage[]> {
  const images: ShareAiImage[] = [];
  for (const filename of extractUploadedImageFilenames(body)) {
    if (images.length >= MAX_SHARE_AI_IMAGES) break;
    if (isSvgImageUrl(filename)) continue;
    const image = await loadOwnedImage(userId, filename);
    if (image) images.push(image);
  }
  return images;
}

/** 起案が済んだ本文の画像のうち、本人の記録を消す */
export async function consumeShareImageUploads(userId: string, body: string): Promise<void> {
  for (const filename of extractUploadedImageFilenames(body)) {
    const record = path.join(SHARE_IMAGE_OWNER_DIR, filename);
    if ((await readFile(record, "utf8").catch(() => null)) === userId) {
      await rm(record, { force: true });
    }
  }
}
