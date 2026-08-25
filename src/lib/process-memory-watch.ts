/**
 * 本番プロセスのRSSを見張り、**最大値を更新したときだけ**ログへ出す（#2331）。
 *
 * ## なぜ要るのか
 *
 * 本番のissue-deckはPM2の`max_memory_restart`で殺されて再起動を繰り返すことがある
 * （#1121 → #1546 → #2331）。ところが**そのときの実際のRSSの増え方を誰も見られない。**
 * `pm2 describe`は「今この瞬間」しか返さず、殺された時点の値は残らない。過去2回はどちらも
 * 「上限を上げる」で収束させたが、上げた値が素の必要量に対して足りていたのか、単に
 * リークの周期が伸びただけなのかを判定する材料が無かった（#1546は10日で再発した）。
 *
 * そこでプロセス自身に自分のRSSを出させる。**判定に要るのは増え方の形**（頭打ちなのか、
 * 一定の速度で増え続けるのか）なので、毎回出す必要はなく、
 * **これまでの最大値を`stepMb`以上更新したときだけ**出せば足りる。
 *
 * - 頭打ちなら、起動直後に数行出たあと静かになる
 * - リークなら、増え続けるかぎり延々と行が増える
 *
 * 平常時のログをほとんど汚さずに、`pm2 logs issue-deck`だけで形が読める。
 *
 * ## 読み方
 *
 * ```
 * [memory] rss=482MB heapTotal=217MB heapUsed=128MB external=41MB uptime=312s
 * ```
 *
 * - `rss`がPM2の`max_memory_restart`と突き合わせる値。この値が閾値に達すると殺される
 * - `rss`と`heapTotal`の差がヒープ外（Prismaのクエリエンジン・undiciのバッファ・コード領域）。
 *   #2331の実測ではここが約264MBあり、`--max-old-space-size`を触っても減らない側だった
 *
 * 値の根拠と再発時の調べ方は [docs/production-memory.md](../../docs/production-memory.md) を参照。
 */

/** 見張る間隔（秒）の既定値。`MEMORY_WATCH_INTERVAL_SECONDS`で変えられる */
export const MEMORY_WATCH_DEFAULT_INTERVAL_SECONDS = 60;

/**
 * ログを出す最大値の更新幅（MB）の既定値。`MEMORY_WATCH_STEP_MB`で変えられる。
 *
 * 小さすぎるとGCの揺れでログが埋まり、大きすぎると増え方の形が読めない。起動直後の
 * 150MB前後から#2331の実測値480MBまでで20行程度になる幅として16MBにしている。
 */
export const MEMORY_WATCH_DEFAULT_STEP_MB = 16;

const MB = 1024 * 1024;

export type ProcessMemorySample = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
};

/** 見張る間隔（秒）。環境変数が読めない・数値でない場合は既定値。**0以下は「見張らない」** */
export function memoryWatchIntervalSeconds(
  raw: string | undefined = process.env.MEMORY_WATCH_INTERVAL_SECONDS,
): number {
  if (raw === undefined || raw.trim() === "") return MEMORY_WATCH_DEFAULT_INTERVAL_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return MEMORY_WATCH_DEFAULT_INTERVAL_SECONDS;
  return value;
}

/** ログを出す最大値の更新幅（MB）。0以下は「毎回出す」ではなく既定値へ倒す */
export function memoryWatchStepMb(
  raw: string | undefined = process.env.MEMORY_WATCH_STEP_MB,
): number {
  if (raw === undefined || raw.trim() === "") return MEMORY_WATCH_DEFAULT_STEP_MB;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return MEMORY_WATCH_DEFAULT_STEP_MB;
  return value;
}

/**
 * いま出すか。**最初の1回（起動直後の基準値）は必ず出す。**
 * 以降は「これまで出した最大値 + `stepMb`」に達したときだけ出す——下がったときに出しても
 * 増え方の形は分からず、GCの揺れでログが埋まるだけのため。
 */
export function shouldLogProcessMemory(input: {
  rssBytes: number;
  lastLoggedRssBytes: number | null;
  stepMb: number;
}): boolean {
  if (input.lastLoggedRssBytes === null) return true;
  return input.rssBytes >= input.lastLoggedRssBytes + input.stepMb * MB;
}

function toMb(bytes: number): number {
  return Math.round(bytes / MB);
}

/** ログ1行。`pm2 logs`でそのまま読める形にする（JSONにしない） */
export function formatProcessMemoryLine(
  sample: ProcessMemorySample,
  uptimeSeconds: number,
): string {
  return [
    "[memory]",
    `rss=${toMb(sample.rss)}MB`,
    `heapTotal=${toMb(sample.heapTotal)}MB`,
    `heapUsed=${toMb(sample.heapUsed)}MB`,
    `external=${toMb(sample.external)}MB`,
    `uptime=${Math.round(uptimeSeconds)}s`,
  ].join(" ");
}

/**
 * 見張りを開始する。戻り値を呼ぶと止まる（テスト用。本番では止めない）。
 *
 * **タイマーは`unref()`する。** これだけが残ってもプロセスを生かし続けないようにするため
 * （Next.jsのサーバーはHTTPサーバーが握っているので実運用では差が出ないが、
 * 見張りが終了を妨げる理由は無い）。
 */
export function startProcessMemoryWatch(
  options: {
    intervalSeconds?: number;
    stepMb?: number;
    sample?: () => ProcessMemorySample;
    uptimeSeconds?: () => number;
    log?: (line: string) => void;
  } = {},
): () => void {
  const intervalSeconds = options.intervalSeconds ?? memoryWatchIntervalSeconds();
  if (intervalSeconds <= 0) return () => {};

  const stepMb = options.stepMb ?? memoryWatchStepMb();
  const sample = options.sample ?? (() => process.memoryUsage());
  const uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
  const log = options.log ?? ((line: string) => console.log(line));

  let lastLoggedRssBytes: number | null = null;

  const tick = () => {
    const current = sample();
    if (!shouldLogProcessMemory({ rssBytes: current.rss, lastLoggedRssBytes, stepMb })) return;
    lastLoggedRssBytes = current.rss;
    log(formatProcessMemoryLine(current, uptimeSeconds()));
  };

  // 起動直後の基準値をまず1行残す。ここが無いと、あとで出た値が「どこから増えたのか」が読めない。
  tick();

  const timer = setInterval(tick, intervalSeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
