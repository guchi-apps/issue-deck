/**
 * アップロード済み画像1件（#2462・#2475）。`GET /api/issues/images`が返す形。
 *
 * 画像そのものはDBに行を持たず`uploads/images/`のファイルがすべて。`size`・`uploadedAt`は
 * 実ファイルから読む。**貼り付け先（`references`）だけはDBの索引**（`UploadedImageReference`）
 * から来る（#2475。索引を作るまでは「未使用」を判定できなかった）。
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
  /** 使用状況（#2475） */
  usage: UploadedImageUsage;
  /** この画像を貼っているIssue・PR。新しい参照が先頭 */
  references: UploadedImageReferenceSummary[];
};

/**
 * 画像の使用状況（#2475）。
 *
 * - `used` … Issue本文かIssue／PRのコメントから参照が見つかっている
 * - `unused` … 参照が見つからず、**かつ索引が全リポジトリぶん一巡し終わっている**
 * - `unknown` … まだ一巡していない。「未使用」とは別物として扱い、自動削除の対象にしない
 */
export type UploadedImageUsage = "used" | "unused" | "unknown";

/** 画像を貼っているIssue・PRの1件ぶん */
export type UploadedImageReferenceSummary = {
  repositoryFullName: string;
  issueNumber: number;
  /** 参照元がPull Requestか（リポジトリ単位のコメント一覧はPRのコメントも返す） */
  isPullRequest: boolean;
};

/** 枚数とバイト数の組 */
export type UploadedImageBucket = {
  count: number;
  size: number;
};

/** 容量サマリー（#2475）。`total`はゴミ箱を含めた全体 */
export type UploadedImageSummary = {
  total: UploadedImageBucket;
  used: UploadedImageBucket;
  unused: UploadedImageBucket;
  unknown: UploadedImageBucket;
  trashed: UploadedImageBucket;
};

/** 参照の索引がどこまで進んでいるか（#2475）。画面に進捗を出すために返す */
export type UploadedImageScanState = {
  /** 全リポジトリのコメントを一度読み切った時刻（ISO文字列）。未完了ならnull */
  completedAt: string | null;
  /** 連携済みリポジトリの数 */
  repositoryCount: number;
  /** そのうちコメントを一度でも読んだリポジトリの数 */
  scannedRepositoryCount: number;
};

/** 自動削除の設定（#2475）。`GET /api/issues/images`が現在値をあわせて返す */
export type UploadedImageCleanupSettings = {
  enabled: boolean;
  retentionDays: number;
  /** ゴミ箱へ移してから完全に削除するまでの日数（環境変数で決まる読み取り専用の値） */
  trashDays: number;
};

/** `GET /api/issues/images`の応答 */
export type UploadedImageListResponse = {
  images: UploadedImage[];
  summary: UploadedImageSummary;
  scan: UploadedImageScanState;
  cleanup: UploadedImageCleanupSettings;
};
