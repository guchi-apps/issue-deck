import type { UploadedImage } from "@/types/uploaded-image";

/**
 * アップロードAPI（`POST /api/issues/images`）が発行するUUIDファイル名の形式。
 *
 * **一覧・配信・削除の3つの受け口がこの1つを共有する。** 配信（`GET`）は認証を要求しない
 * ので、この形式に合う名前しか受け付けないことがパストラバーサルとファイル列挙の防波堤に
 * なっている（docs/code-map.md「画像・アーティファクトはVPSのローカルディスクに置く」）。
 * 片方だけ緩めると防波堤が崩れるため、正規表現を各ファイルへ写さずここから読む。
 */
export const UPLOADED_IMAGE_FILENAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

export function isUploadedImageFilename(filename: string): boolean {
  return UPLOADED_IMAGE_FILENAME_PATTERN.test(filename);
}

/** `uploads/images/`から読んだファイル1件ぶんの生の情報 */
export type UploadedImageFile = {
  filename: string;
  size: number;
  /** ファイルの更新時刻（エポックミリ秒） */
  modifiedAtMs: number;
};

/**
 * ディレクトリの読み取り結果を画面へ出す一覧に整える（#2462）。
 *
 * アップロードAPIが作った名前でないファイル（手で置いたもの・作りかけ）は落とす。
 * 並びは**新しい順**——消したくなるのは直前に貼った画像であることが多い。
 * 更新時刻が同じものはファイル名で並べ、取得のたびに順序が入れ替わらないようにする。
 */
export function buildUploadedImageList(files: UploadedImageFile[]): UploadedImage[] {
  return files
    .filter((file) => isUploadedImageFilename(file.filename))
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs || a.filename.localeCompare(b.filename))
    .map((file) => ({
      filename: file.filename,
      url: `/api/issues/images/${file.filename}`,
      size: file.size,
      uploadedAt: new Date(file.modifiedAtMs).toISOString(),
    }));
}

/** 一覧に添えるファイルサイズ。KB未満は1KBに丸める（0KBと出すと壊れて見えるため） */
export function formatUploadedImageSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(size / 1024))}KB`;
}
