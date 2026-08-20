/**
 * workflowを起動してから、その結果が画面に現れるまでの間、二度押しを止めるための判定
 * （#1548でリリース向けに入れ、#2020で本番デプロイと共有した）。
 *
 * 起動しても、結果（バンプPR・デプロイの実行）が作られて画面に現れるまでには時間がかかる。
 * その間はボタンを出す条件が真のまま残るので、押せるボタンが残り、押したぶんだけworkflowが
 * 起動する。
 *
 * **サーバー側に押下を記録しない。** ブランチ画面は「追加のGitHub API取得をしない」前提で
 * 作られており（`lib/branch-flow.ts`）、実行中かどうかを問い合わせるとその前提が崩れる。
 * 起動時刻を端末のlocalStorageへ置き、下の判定で押せない期間を決める。
 */

/**
 * リリースを起動済みとして扱う時間（ミリ秒）。**失効させるのは、workflowが失敗してバンプPRが
 * 1本も作られなかったときにボタンが二度と押せなくなるのを防ぐため。** 通常はバンプPRが現れた
 * 時点で`canTriggerRelease`がfalseになりボタン自体が消えるので、この時間まで待つことはない。
 */
export const RELEASE_TRIGGER_PENDING_MS = 10 * 60 * 1000;

/**
 * 本番デプロイを起動済みとして扱う時間（ミリ秒。#2020）。**リリースより短い。**
 * `deploy.yml`の実行はdispatchから数秒で現れ、現れた時点で`canTriggerDeploy`がfalseになる。
 * ここまで待つのは、dispatchが受理されたのに実行が現れなかったときの失効だけ。
 */
export const DEPLOY_TRIGGER_PENDING_MS = 3 * 60 * 1000;

/**
 * 直近の起動から「まだ起動中」とみなす期間内かどうか。
 * 起動していない（null）・時刻として読めない・失効した場合はfalse（＝押せる）。
 */
export function isTriggerPending(
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
