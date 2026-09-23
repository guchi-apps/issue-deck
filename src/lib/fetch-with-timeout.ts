/**
 * 画面から自前のAPIを叩くときのタイムアウト付きfetch（#3387）。
 *
 * **ブラウザのfetchは自分ではタイムアウトしない。** 回線が不安定だと、リクエストは出たのに
 * 応答が返らないまま約束が決着しない通信が起こる。そうなると「取得中」の表示が消えず、
 * 「前の取得が終わるまで次を出さない」ガード（`inFlightRef`）を持つポーリングは以後の周回を
 * 全部見送り続ける——画面にはエラーも出ず、更新だけが黙って止まる。
 *
 * ここでは一定時間で通信を打ち切り、`FetchTimeoutError`で失敗させる。呼び出し側は通常の
 * 失敗と同じく扱えばよく、ポーリングなら次の周回で回復する。
 *
 * - **本文の読み出し（`res.json()`）まで同じ期限で切る。** ヘッダーだけ返って本文が
 *   流れてこない詰まり方もあるため、タイマーは応答が返った時点では止めない
 *   （完了済みの通信へのabortは何も起こさない）
 * - 呼び出し側の`signal`（画面を離れたときの中断）はそのまま効く。中断の理由は呼び出し側の
 *   ものを引き継ぐので、既存の`AbortError`の判定はそのまま使える
 * - `AbortSignal.any`は使わない（iOS Safari 17.4未満に無い）
 */

/** 既定の打ち切りまでの時間。GitHub APIを束ねて叩く重い取得は呼び出し側で延ばす */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * リポジトリ横断でGitHub APIを束ねて叩く取得（PR一覧・ブランチ状況）の打ち切り時間。
 * 回線が健全でもサーバー側で数十秒かかることがあるため、既定より長く取る
 */
export const SLOW_FETCH_TIMEOUT_MS = 90_000;

export class FetchTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`通信がタイムアウトしました（${Math.round(timeoutMs / 1000)}秒）`);
    this.name = "FetchTimeoutError";
  }
}

export type FetchWithTimeoutInit = RequestInit & { timeoutMs?: number };

export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: FetchWithTimeoutInit = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal: callerSignal, ...rest } = init;
  const controller = new AbortController();

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), {
        once: true,
      });
    }
  }

  setTimeout(() => controller.abort(new FetchTimeoutError(timeoutMs)), timeoutMs);

  return fetch(input, { ...rest, signal: controller.signal });
}

/** 画面を離れたなど、呼び出し側が自分で中断した失敗か。タイムアウトはここに含めない */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
