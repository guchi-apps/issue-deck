/**
 * 「リリースする」を押してからバンプPRが現れるまでの間、二度押しを止めるための判定（#1548）。
 *
 * リリースworkflowを起動しても、バンプPRが作られて画面に現れるまでには数十秒かかる。その間
 * `canTriggerRelease`はtrueのままなので、押せるボタンが残り、押したぶんだけworkflowが起動する
 * （workflow側は既存のバンプPRがあれば作成をスキップするためPRは二重にならないが、
 * バージョン判定のClaude実行は毎回走る）。
 *
 * **サーバー側に押下を記録しない。** この画面は「追加のGitHub API取得をしない」前提で作られており
 * （`lib/branch-flow.ts`）、実行中かどうかを問い合わせるとその前提が崩れる。起動時刻を端末の
 * localStorageへ置き、下の判定で押せない期間を決める。
 */

/**
 * 起動済みとして扱う時間（ミリ秒）。**失効させるのは、workflowが失敗してバンプPRが1本も
 * 作られなかったときにボタンが二度と押せなくなるのを防ぐため。** 通常はバンプPRが現れた時点で
 * `canTriggerRelease`がfalseになりボタン自体が消えるので、この時間まで待つことはない。
 */
export const RELEASE_TRIGGER_PENDING_MS = 10 * 60 * 1000;

/**
 * 直近の起動から「まだ起動中」とみなす期間内かどうか。
 * 起動していない（null）・時刻として読めない・失効した場合はfalse（＝押せる）。
 */
export function isReleaseTriggerPending(
  triggeredAt: string | null | undefined,
  now: number,
  pendingMs: number = RELEASE_TRIGGER_PENDING_MS,
): boolean {
  if (!triggeredAt) return false;
  const startedAt = new Date(triggeredAt).getTime();
  if (Number.isNaN(startedAt)) return false;
  // 端末の時計が戻された場合など、未来の時刻が入っていても押せない側へ倒す（安全側）。
  if (startedAt > now) return true;
  return now - startedAt < pendingMs;
}
