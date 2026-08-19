/**
 * 一覧を下へ引っ張って更新する操作（#1893）の判定。DOMに触れない部分だけをここに置く。
 *
 * 端末標準の「引っ張って更新」は使えない。アプリシェルを固定するために
 * `app/layout.tsx`で`overscroll-none`（＋`body`の`fixed inset-0`）を指定しており、
 * ドキュメント自体が動かないようにしてあるため（#607）。ホーム画面から起動したPWAには
 * ブラウザのツールバーも無いので、一覧の画面には更新の手段が残っていなかった。
 */

/** 更新が確定する引っ張り量。これを超えると「離すと更新」へ変わる */
export const PULL_THRESHOLD_PX = 64;
/** 引っ張り量の上限。これ以上引いても追従しない */
export const PULL_MAX_PX = 80;
/** 指の移動量に対する追従の割合。1のままだと軽すぎて誤操作が増える */
export const PULL_RESISTANCE = 0.5;
/** 更新中に一覧を下げておく量。インジケーターの高さでもある */
export const PULL_SPINNER_PX = 48;
/**
 * 更新中の表示を保つ下限（`use-dispatch-state.ts`の`MIN_FETCHING_MS`と同じ意図）。
 *
 * 叩き先は自前の`GET /api/issues`（DBの読み取りのみ）で数十msで返ることが多く、
 * 素直に「取得している間だけ」にすると回転が1周もせずに消え、点滅にしか見えない。
 */
export const MIN_REFRESHING_MS = 500;
/**
 * 外の取得の完了を待つ上限（#1958）。
 *
 * ブランチ画面のようにGitHub APIを叩く画面では、取り直しが数秒かかる。取得中かどうかを
 * 外から受け取って（`usePullToRefresh`の`isRefreshing`）「更新中…」を保つが、応答が返らない
 * ままフラグが下りない場合に表示が残り続けるのを防ぐため、ここで打ち切る。
 * **打ち切るのは表示だけで、取得そのものは止めない。**
 */
export const MAX_EXTERNAL_REFRESHING_MS = 15_000;
/**
 * 外の取得が「始まる」のを待つ上限（#1958）。
 *
 * **取り直しの合図（`use-branch-flow.ts`・`use-pull-requests.ts`の`refresh`）は同期関数で、
 * 呼んだ時点ではまだ取得中フラグが立っていない。** 待たずに見に行くと立つ前に素通りし、
 * 下限（`MIN_REFRESHING_MS`）だけで表示が消える。立たないまま過ぎたら、その画面は
 * 取得しなかったものとして扱い待つのをやめる。
 */
export const EXTERNAL_REFRESHING_START_MS = 1_000;
/** 外の取得中フラグを見に行く間隔（#1958）。フラグはrefで読むため自分で確認する */
export const EXTERNAL_REFRESHING_POLL_MS = 100;

export type PullPhase = "idle" | "pull" | "ready" | "refreshing";

/**
 * 指の移動量（下向きが正）から、一覧を下げる量を求める。
 * 上向き（負）は0にする——通常のスクロールとして扱う分なので追従させない。
 */
export function resolvePullDistance(deltaY: number): number {
  if (deltaY <= 0) return 0;
  return Math.min(deltaY * PULL_RESISTANCE, PULL_MAX_PX);
}

export function resolvePullPhase(distance: number, isRefreshing: boolean): PullPhase {
  if (isRefreshing) return "refreshing";
  if (distance <= 0) return "idle";
  return distance >= PULL_THRESHOLD_PX ? "ready" : "pull";
}

/** インジケーターに出す文言。`idle`は何も出さない */
export function resolvePullLabel(phase: PullPhase): string | null {
  if (phase === "pull") return "引っ張って更新";
  if (phase === "ready") return "離すと更新";
  if (phase === "refreshing") return "更新中…";
  return null;
}

/**
 * 矢印の回転角。しきい値に届いた時点で1周する。
 * 引っ張った量がそのまま「あとどれくらいで更新されるか」として読めるようにする。
 */
export function resolvePullArrowDegrees(distance: number): number {
  return Math.min(distance / PULL_THRESHOLD_PX, 1) * 360;
}

/** 更新中の表示を`MIN_REFRESHING_MS`保つために、あと何ms待つか */
export function remainingRefreshingMs(elapsedMs: number): number {
  return Math.max(0, MIN_REFRESHING_MS - elapsedMs);
}
