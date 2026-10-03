/**
 * 予約実行の設定で使う、横スクロールの目盛り帯（#3821）の計算。
 * 値は選択肢（`NEXT_WINDOW_RUN_*_OPTIONS`）のどれかに必ず吸着させる。
 */

/** Claudeの5時間枠の長さ（分） */
export const FIVE_HOUR_WINDOW_MINUTES = 300;

/** `scrollLeft`（中央の針の位置）に最も近い選択肢を返す。`scale`は値→横位置（px）の写像 */
export function nearestOption(options: readonly number[], scale: (value: number) => number, scrollLeft: number): number {
  let best = options[0];
  for (const option of options) {
    if (Math.abs(scale(option) - scrollLeft) < Math.abs(scale(best) - scrollLeft)) best = option;
  }
  return best;
}

/** 隣の選択肢（`direction`が-1なら左、1なら右）。端では動かない */
export function stepOption(options: readonly number[], value: number, direction: -1 | 1): number {
  const index = options.indexOf(value);
  if (index < 0) return value;
  return options[Math.min(options.length - 1, Math.max(0, index + direction))];
}

export type WindowTimeline = {
  /** 枠の開始から「いま」までの位置（0〜100）。いまが分からないときはnull */
  nowPercent: number | null;
  /** 起動する位置（0〜100） */
  launchPercent: number;
  /** 起動する時刻（ISO） */
  launchAtIso: string;
};

/**
 * 5時間枠の帯の上の「いま」と「起動する位置」。開始時刻は`resetsAt`から5時間さかのぼる。
 * `leadMinutes`は枠のリセットの何分前に起動するか。
 */
export function buildWindowTimeline(resetsAtIso: string, nowMs: number | null, leadMinutes: number): WindowTimeline | null {
  const resetsMs = new Date(resetsAtIso).getTime();
  if (!Number.isFinite(resetsMs)) return null;
  const startMs = resetsMs - FIVE_HOUR_WINDOW_MINUTES * 60_000;
  const clamp = (percent: number) => Math.min(100, Math.max(0, percent));
  const launchAtMs = resetsMs - leadMinutes * 60_000;
  return {
    nowPercent: nowMs === null ? null : clamp(((nowMs - startMs) / (resetsMs - startMs)) * 100),
    launchPercent: clamp(((launchAtMs - startMs) / (resetsMs - startMs)) * 100),
    launchAtIso: new Date(launchAtMs).toISOString(),
  };
}
