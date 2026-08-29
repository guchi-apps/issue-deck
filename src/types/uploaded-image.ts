/**
 * アップロード済み画像1件（#2462）。`GET /api/issues/images`が返す形。
 *
 * 画像はDBに行を持たず`uploads/images/`のファイルがすべてなので、ここに出る値は
 * 実ファイルから読んだものだけ（持ち主・貼り付け先のIssueは記録が無く、出せない）。
 */
export type UploadedImage = {
  /** UUID + 拡張子のファイル名 */
  filename: string;
  /** 配信URL（`/api/issues/images/<filename>`） */
  url: string;
  /** バイト数 */
  size: number;
  /**
   * アップロード日時（ISO文字列）。ファイルの更新時刻を読んでいる。
   * アップロード後に書き換えることが無いため、これが実質のアップロード日時になる。
   */
  uploadedAt: string;
};
