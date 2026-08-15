import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";

/**
 * ホストが申告するリソース使用率（#1567）。
 *
 * サブPCで何本セッションを起こしてよいかを判断するのに、従来は**別のアプリ**
 * （ops-dashboard）を開く必要があった。判断に効く3つ（CPU・メモリ・`/`のディスク）だけを
 * pollerの申告に相乗りさせ、実行キューと同じ場所に出す。
 *
 * **境界は「セッションを起こしてよいかに効くか」**。サービス・プロセス・温度・ネットワーク・
 * 履歴といったホスト全体の監視は引き続きops-dashboardの担当で、こちらへは持ち込まない
 * （経緯は`src/app/api/dispatch/hosts/route.ts`のコメント）。
 *
 * **判定には使わない。** 起動を止めているのは`maxSessions`（#1361）と同時実行数だけで、
 * ここは画面へ出すための写し。使用率が高いことを理由にジョブの払い出しを止めたりはしない。
 *
 * Prismaに触れないため、クライアントコンポーネントからimportできる
 * （`issue-session.ts`・`queue-summary.ts`と同じ形）。
 */

/**
 * 申告1回ぶんの使用率。
 *
 * **5つはまとめて入るか、まとめて`null`か**のどちらかで、部分的には埋まらない
 * （`parseDispatchHostMetrics`が1つでも壊れていれば全体を落とす）。片方だけ埋まった状態を
 * 許すと、取れなかった項目が0＝空いていると読めてしまう。
 */
export type DispatchHostMetrics = {
  /** 0〜100 */
  cpuPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
};

function parseFinite(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > max) return null;
  return value;
}

/** 総量として受け入れる上限。桁を間違えた申告で画面の目盛りが壊れるのを防ぐだけの緩い上限 */
const MAX_MEMORY_MB = 8 * 1024 * 1024;
const MAX_DISK_GB = 1024 * 1024;

/**
 * pollerが送ってきた`metrics`を検証する。**1つでも外れたら全体を`null`にする。**
 *
 * 使用量が総量を超えている申告も落とす。割合の計算がそのまま100%超になり、
 * 目盛りが振り切れた状態と「本当に埋まっている」状態を見分けられなくなるため。
 * 総量が0の申告も落とす（割合を出せない）。
 */
export function parseDispatchHostMetrics(value: unknown): DispatchHostMetrics | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;

  const cpuPercent = parseFinite(input.cpuPercent, 100);
  const memoryUsedMb = parseFinite(input.memoryUsedMb, MAX_MEMORY_MB);
  const memoryTotalMb = parseFinite(input.memoryTotalMb, MAX_MEMORY_MB);
  const diskUsedGb = parseFinite(input.diskUsedGb, MAX_DISK_GB);
  const diskTotalGb = parseFinite(input.diskTotalGb, MAX_DISK_GB);
  if (
    cpuPercent === null ||
    memoryUsedMb === null ||
    memoryTotalMb === null ||
    diskUsedGb === null ||
    diskTotalGb === null
  ) {
    return null;
  }
  if (memoryTotalMb === 0 || diskTotalGb === 0) return null;
  if (memoryUsedMb > memoryTotalMb || diskUsedGb > diskTotalGb) return null;

  return {
    cpuPercent,
    memoryUsedMb: Math.round(memoryUsedMb),
    memoryTotalMb: Math.round(memoryTotalMb),
    diskUsedGb,
    diskTotalGb,
  };
}

/**
 * 使用率の重さ。**同時実行数・セッション本数の上限とは無関係**で、見た人が
 * 「もう1本起こすのはやめておくか」を判断するための目安でしかない。
 */
export type DispatchHostMetricTone = "normal" | "warn" | "critical";

/** 橙・赤へ変わる境目 */
const WARN_PERCENT = 60;
const CRITICAL_PERCENT = 85;

export function resolveHostMetricTone(percent: number): DispatchHostMetricTone {
  if (percent >= CRITICAL_PERCENT) return "critical";
  if (percent >= WARN_PERCENT) return "warn";
  return "normal";
}

/** 画面に出す1行 */
export type DispatchHostMetricRow = {
  label: string;
  /** 0〜100。メーターの幅に使う */
  percent: number;
  /** 割合の右に添える実数（CPUは割合そのものなのでnull） */
  detail: string | null;
  tone: DispatchHostMetricTone;
};

/** MBをGB表記へ。1桁までにするのは、幅20remのポップオーバーで桁を揃えるため */
function formatGb(gb: number): string {
  return gb.toFixed(1);
}

/**
 * 申告された使用率を画面の行へ直す。**出せない場合は`null`**（メーターごと出さない）。
 *
 * 出さないのは次の2つ。どちらも「古い数字を今の値として見せない」ためで、
 * 0%として並べると、実際には埋まっているホストが空いているように見える。
 *
 * - 申告が無い（古いpoller・取得に失敗した巡）
 * - ホストが応答していない（`online`がfalse。最後の申告から一定時間が過ぎている）
 */
export function describeDispatchHostMetrics(host: DispatchHostView): DispatchHostMetricRow[] | null {
  const metrics = host.metrics;
  if (!metrics || !host.online) return null;

  const memoryPercent = (metrics.memoryUsedMb / metrics.memoryTotalMb) * 100;
  const diskPercent = (metrics.diskUsedGb / metrics.diskTotalGb) * 100;

  return [
    {
      label: "CPU",
      percent: metrics.cpuPercent,
      detail: null,
      tone: resolveHostMetricTone(metrics.cpuPercent),
    },
    {
      label: "メモリ",
      percent: memoryPercent,
      detail: `${formatGb(metrics.memoryUsedMb / 1024)} / ${formatGb(metrics.memoryTotalMb / 1024)} GB`,
      tone: resolveHostMetricTone(memoryPercent),
    },
    {
      label: "ディスク",
      percent: diskPercent,
      detail: `${formatGb(metrics.diskUsedGb)} / ${formatGb(metrics.diskTotalGb)} GB`,
      tone: resolveHostMetricTone(diskPercent),
    },
  ];
}

/** メーターの右に出す割合の文字列 */
export function formatHostMetricPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}
