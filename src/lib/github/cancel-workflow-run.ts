/** 通常キャンセル要求後、強制キャンセルの選択肢を表示するまでの待ち時間(ms) */
export const FORCE_CANCEL_AVAILABLE_AFTER_MS = 35_000;

/**
 * 通常キャンセルの要求時刻から、強制キャンセルを提案してよい経過時間に達したかを判定する。
 * ポーリング間隔(20秒)より長い閾値にすることで、正常にキャンセル処理中のRunを
 * 誤って強制キャンセル対象と判定しないようにする。
 */
export function isForceCancelAvailable(
  requestedAtMs: number,
  nowMs: number,
  thresholdMs: number = FORCE_CANCEL_AVAILABLE_AFTER_MS,
): boolean {
  return nowMs - requestedAtMs >= thresholdMs;
}
