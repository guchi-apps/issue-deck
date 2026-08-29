/**
 * 参照されていない添付画像の後始末（#2475）の判定。**IOを持たない純ロジック**で、
 * DB・GitHub・ファイルシステムを触る側は[`image-cleanup-run.ts`](./image-cleanup-run.ts)。
 *
 * ## なぜ「消す」ではなく「ゴミ箱へ移す」なのか
 *
 * 未使用の判定はIssue本文（DBのキャッシュ）とIssue／PRのコメント本文しか見ておらず、
 * **PR本文・PRのレビューコメント・リポジトリ内のファイル・投稿前の下書き・GitHub外への
 * 貼り付けは原理的に見えない**。人が押した1枚削除と違い、こちらは無人で走るので、
 * 取り違えたときに戻す手段が要る。`uploads/images/.trash/`へ`rename`しておけば、
 * ゴミ箱にある間に参照が見つかった時点で巡回が自分で戻せる。
 *
 * ゴミ箱に置きっぱなしでは容量が空かないので、移してから`trashDays`が過ぎたものは
 * 本当に消す。**猶予が二段（`retentionDays` → `trashDays`）になっているのが安全装置の本体**で、
 * 「参照0件を観測し続けた期間」をゴミ箱の滞在期間が兼ねている。
 */

/** 巡回の間隔（分）の既定値。`IMAGE_CLEANUP_SWEEP_INTERVAL_MINUTES`で変えられる */
export const IMAGE_CLEANUP_SWEEP_DEFAULT_INTERVAL_MINUTES = 60;

/** ゴミ箱へ移してから完全に削除するまでの日数の既定値。`IMAGE_TRASH_DAYS`で変えられる */
export const IMAGE_TRASH_DEFAULT_DAYS = 30;

/** 1回の巡回で1リポジトリから読むコメントのページ数の上限（1ページ100件） */
export const IMAGE_COMMENT_SCAN_MAX_PAGES = 10;

/**
 * `since`で差分を取るときにカーソルを戻す幅（ミリ秒）。
 *
 * GitHubのドキュメントは`since`を "last updated after the given time" としか書いておらず、
 * 境界を含むかどうかが仕様として保証されていない。同じ秒に複数のコメントがあるとページの
 * 境目で1件落ちるため、少し戻して重ねて読む（書き込みは`upsert`なので二重に読んでも害が無い）。
 */
export const IMAGE_COMMENT_SCAN_OVERLAP_MS = 60_000;

/**
 * 削除フェーズを中止する参照総数の減り具合（#2475）。
 *
 * リポジトリの連携が外れる・GitHub APIが一時的に空を返すといった事故で参照が一斉に消えると、
 * 使っている画像がまとめて「未使用」に見える。1回の巡回で参照がこの割合を下回るまで減った
 * ときは、判定そのものを信用せずに削除を丸ごと見送る。
 */
export const IMAGE_REFERENCE_DROP_ABORT_RATIO = 0.8;

export function imageCleanupSweepIntervalMinutes(
  raw: string | undefined = process.env.IMAGE_CLEANUP_SWEEP_INTERVAL_MINUTES,
): number {
  return parsePositiveEnvNumber(raw, IMAGE_CLEANUP_SWEEP_DEFAULT_INTERVAL_MINUTES);
}

export function imageTrashDays(raw: string | undefined = process.env.IMAGE_TRASH_DAYS): number {
  return parsePositiveEnvNumber(raw, IMAGE_TRASH_DEFAULT_DAYS);
}

function parsePositiveEnvNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** 巡回が扱うファイル1件ぶん（`uploads/images/`と`.trash/`で同じ形） */
export type ImageCleanupFile = {
  filename: string;
  /** ファイルの更新時刻（エポックミリ秒）。ゴミ箱の中では「移した時刻」になる */
  modifiedAtMs: number;
};

/** 巡回を見送る理由 */
export type ImageCleanupSkipReason =
  /** 設定でOFFになっている */
  | "disabled"
  /** 参照の索引がまだ全リポジトリぶん一巡していない */
  | "scan_incomplete"
  /** 索引が一巡した時刻より後にアップロードされた画像しか無い（＝まだ確かめていない） */
  | "scan_older_than_upload"
  /** この巡回で参照が急に減った。判定を信用せず見送る */
  | "reference_drop";

export type ImageCleanupDecision = {
  /** ゴミ箱へ移すファイル名 */
  toTrash: string[];
  /** 見送った理由（`toTrash`が空でも理由が無いことはある＝対象が無いだけ） */
  skipped: ImageCleanupSkipReason | null;
};

/**
 * ゴミ箱へ移す画像を決める。
 *
 * 条件は**すべて**満たすこと。1つでも欠けたら何も消さない。
 *
 * 1. 設定でONになっている
 * 2. 参照の索引が全リポジトリぶん一巡し終わっている
 * 3. その一巡が終わったのが、画像をアップロードした後（後から貼られた参照を見落とさないため）
 * 4. 参照が1件も見つかっていない
 * 5. アップロードから`retentionDays`が過ぎている
 * 6. この巡回で参照が急に減っていない
 */
export function decideImageCleanup(params: {
  files: ImageCleanupFile[];
  /** 参照が1件以上見つかっているファイル名 */
  referencedFilenames: ReadonlySet<string>;
  enabled: boolean;
  retentionDays: number;
  /** 参照の索引が全リポジトリぶん一巡し終わった時刻。未完了ならnull */
  scanCompletedAt: Date | null;
  /** 収集の前後の参照総数。減り方が急なら削除を丸ごと見送る */
  referenceCountBefore: number;
  referenceCountAfter: number;
  now: Date;
}): ImageCleanupDecision {
  const {
    files,
    referencedFilenames,
    enabled,
    retentionDays,
    scanCompletedAt,
    referenceCountBefore,
    referenceCountAfter,
    now,
  } = params;

  if (!enabled) return { toTrash: [], skipped: "disabled" };
  if (scanCompletedAt === null) return { toTrash: [], skipped: "scan_incomplete" };

  if (
    referenceCountBefore > 0 &&
    referenceCountAfter < referenceCountBefore * IMAGE_REFERENCE_DROP_ABORT_RATIO
  ) {
    return { toTrash: [], skipped: "reference_drop" };
  }

  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const scanCompletedAtMs = scanCompletedAt.getTime();
  let sawUploadAfterScan = false;
  const toTrash: string[] = [];

  for (const file of files) {
    if (referencedFilenames.has(file.filename)) continue;
    if (now.getTime() - file.modifiedAtMs < retentionMs) continue;
    if (file.modifiedAtMs >= scanCompletedAtMs) {
      // 索引が一巡し終わったより後に置かれた画像。まだ一度も全体を確かめていないので触らない
      sawUploadAfterScan = true;
      continue;
    }
    toTrash.push(file.filename);
  }

  if (toTrash.length === 0 && sawUploadAfterScan) {
    return { toTrash: [], skipped: "scan_older_than_upload" };
  }
  return { toTrash, skipped: null };
}

/**
 * ゴミ箱から元へ戻す画像を決める。
 *
 * **ゴミ箱に入れた後で参照が見つかったもの**が対象。判定を間違えて移してしまった画像を、
 * 人が気付く前に巡回が自分で戻すための経路で、これがあるおかげで「未使用」の判定を
 * 多少強気に倒せる。
 */
export function decideTrashRestore(params: {
  trashFiles: ImageCleanupFile[];
  referencedFilenames: ReadonlySet<string>;
}): string[] {
  return params.trashFiles
    .filter((file) => params.referencedFilenames.has(file.filename))
    .map((file) => file.filename);
}

/**
 * ゴミ箱から完全に削除する画像を決める。移してから`trashDays`が過ぎたものだけ。
 *
 * 参照が見つかったものは`decideTrashRestore`が先に戻すので、ここへは来ない。
 */
export function decideTrashPurge(params: {
  trashFiles: ImageCleanupFile[];
  referencedFilenames: ReadonlySet<string>;
  trashDays: number;
  now: Date;
}): string[] {
  const trashMs = params.trashDays * 24 * 60 * 60 * 1000;
  return params.trashFiles
    .filter((file) => !params.referencedFilenames.has(file.filename))
    .filter((file) => params.now.getTime() - file.modifiedAtMs >= trashMs)
    .map((file) => file.filename);
}

/**
 * 参照の索引が全リポジトリぶん一巡し終わったかを**毎回計算する**（#2475）。
 *
 * **フラグを1つ持って立てっぱなしにしない。** 列に`@default(now())`のような初期値を持たせると、
 * マイグレーション直後やバックアップからの復元直後に「全件確認済み・参照0件」という最悪の
 * 状態が成立し、次の巡回が全部消しにかかる。
 */
export function isImageScanComplete(params: {
  /** 連携済みリポジトリ（コメントを読み終えた時刻。未読はnull） */
  repositories: { imageCommentScanAt: Date | null; lastSyncedAt: Date | null }[];
  /** この巡回で、まだ読み残しているリポジトリがあったか */
  hasPendingPages: boolean;
  /** この巡回で1つでもリポジトリの取得に失敗したか */
  hasErrors: boolean;
}): boolean {
  const { repositories, hasPendingPages, hasErrors } = params;
  if (repositories.length === 0) return false;
  if (hasPendingPages || hasErrors) return false;
  return repositories.every((repo) => repo.imageCommentScanAt !== null && repo.lastSyncedAt !== null);
}

/**
 * `since`に渡すカーソルを、読み終えた最後のコメントの`updated_at`から作る。
 *
 * **巡回の開始時刻を書かないこと。** ページ数の上限で打ち切る作りなので、開始時刻を
 * カーソルにすると打ち切った残りを丸ごと飛ばす。境界の取りこぼしを防ぐため少し戻す。
 */
export function nextCommentScanCursor(
  lastUpdatedAt: Date | null,
  previous: Date | null,
): Date | null {
  if (lastUpdatedAt === null) return previous;
  const shifted = new Date(lastUpdatedAt.getTime() - IMAGE_COMMENT_SCAN_OVERLAP_MS);
  if (previous !== null && shifted.getTime() < previous.getTime()) return previous;
  return shifted;
}
