import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";

/**
 * ホストが申告するリソース使用率（#1567）。
 *
 * サブPCで何本セッションを起こしてよいかを判断するのに、従来は**別のアプリ**
 * （ops-dashboard）を開く必要があった。判断に効くもの（CPU・メモリ・SWAP・`/`のディスク）だけを
 * pollerの申告に相乗りさせ、実行キューと同じ場所に出す。
 *
 * **SWAPは#1624で足した。** メモリが100%に達したホストは、そこから先の余力の有無がSWAPの
 * 増え方にしか出ず、「もう1本起こしてよいか」をメモリの割合だけでは判断できなかった。
 *
 * **境界は「セッションを起こしてよいかに効くか」**。サービス・プロセス・温度・ネットワーク・
 * 履歴といったホスト全体の監視は引き続きops-dashboardの担当で、こちらへは持ち込まない
 * （経緯は`src/app/api/dispatch/hosts/route.ts`のコメント）。
 *
 * **この数字そのものは判定に使わない。** issue-deck側がジョブの払い出しを止めるのは
 * 同時実行数だけで、ここは画面へ出すための写し。
 *
 * **ただし#2095から、poller側はこの数字を見て起動ジョブを見送る。** 閾値を超えた巡は
 * `maxJobs: 0`でclaimし、見送っていること自体を`launchHold`として申告してくる
 * （`DispatchHostLaunchHold`）。**判定はあくまでpoller側**で、issue-deckは受け取った結果を
 * 画面へ出すだけ（閾値はホストの搭載メモリで決まるため、`maxSessions`と同じく
 * サブPCの`dispatch.env`が正）。
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
 *
 * **SWAPの2つだけは、この5つと同じ扱いにできない**（#1624）。SWAPを持たないホストと、
 * SWAPを申告しない古いpollerがどちらもありうるため、必須にすると**CPU・メモリ・ディスクごと
 * 消えてしまう**。そのためSWAPは対で`null`になれる（2つとも入るか、2つとも`null`か）。
 */
export type DispatchHostMetrics = {
  /** 0〜100 */
  cpuPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
  /**
   * SWAP（#1624）。**`null`は「申告していない」**（SWAPを申告しない古いpoller）で、
   * 総量0（SWAPを持たないホスト・`swapoff`）とは区別する。どちらの場合も画面には出さない。
   */
  swapUsedMb: number | null;
  swapTotalMb: number | null;
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

  const swap = parseSwap(input);
  if (swap === "invalid") return null;

  return {
    cpuPercent,
    memoryUsedMb: Math.round(memoryUsedMb),
    memoryTotalMb: Math.round(memoryTotalMb),
    diskUsedGb,
    diskTotalGb,
    swapUsedMb: swap.usedMb,
    swapTotalMb: swap.totalMb,
  };
}

/**
 * SWAPの2つを読む（#1624）。**総量0を落とさない**のがメモリ・ディスクとの違いで、
 * SWAPを持たないホスト（`swapoff`）の正常な申告だから。0で割らないよう、割合を出すのは
 * `describeDispatchHostMetrics`側で総量が0でないことを確かめてから。
 *
 * - 2つとも送られていない → 申告なし（`null`の対）。**他の5つは落とさない**
 * - 片方だけ・値が壊れている → `"invalid"`（呼び出し側が`metrics`ごと落とす）
 */
function parseSwap(
  input: Record<string, unknown>,
): { usedMb: number | null; totalMb: number | null } | "invalid" {
  if (input.swapUsedMb == null && input.swapTotalMb == null) {
    return { usedMb: null, totalMb: null };
  }

  const usedMb = parseFinite(input.swapUsedMb, MAX_MEMORY_MB);
  const totalMb = parseFinite(input.swapTotalMb, MAX_MEMORY_MB);
  if (usedMb === null || totalMb === null) return "invalid";
  if (usedMb > totalMb) return "invalid";

  return { usedMb: Math.round(usedMb), totalMb: Math.round(totalMb) };
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
 *
 * **SWAPの行だけは条件付きで出る**（#1624）。申告が無いホストと、SWAPを持たないホスト
 * （総量0）では行ごと出さない。0%のメーターを並べても「SWAPが空いている」と「SWAPが無い」を
 * 見分けられず、行が1つ増えるぶん他の3つが読みにくくなるだけのため。
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
    // メモリの直後に置く。SWAPは「メモリが足りたか」の続きとして読むもので、離すと
    // ディスクの一種のように見える
    ...describeSwapRow(metrics),
    {
      label: "ディスク",
      percent: diskPercent,
      detail: `${formatGb(metrics.diskUsedGb)} / ${formatGb(metrics.diskTotalGb)} GB`,
      tone: resolveHostMetricTone(diskPercent),
    },
  ];
}

/**
 * SWAPの行（#1624）。**出せないときは空の配列**で、行そのものが並ばない。
 *
 * 出さないのは「申告していない」（対が`null`）と「SWAPを持たない」（総量0）の2つ。
 * 割合の重さの境目はCPU・メモリと同じ（60%・85%）にしてある。**SWAPだけ別の境目を設けない**のは、
 * 同じ色が画面の中で違う重さを指すのを避けるため。少しでも使われていること自体を異常として
 * 見せたいわけではなく（Linuxは平常時も僅かに退避する）、見たいのは「増え続けているか」。
 */
function describeSwapRow(metrics: DispatchHostMetrics): DispatchHostMetricRow[] {
  const { swapUsedMb, swapTotalMb } = metrics;
  if (swapUsedMb === null || swapTotalMb === null || swapTotalMb === 0) return [];

  const percent = (swapUsedMb / swapTotalMb) * 100;
  return [
    {
      label: "SWAP",
      percent,
      detail: `${formatGb(swapUsedMb / 1024)} / ${formatGb(swapTotalMb / 1024)} GB`,
      tone: resolveHostMetricTone(percent),
    },
  ];
}

/** メーターの右に出す割合の文字列 */
export function formatHostMetricPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/**
 * 起動を見送っている理由（#2095）。`MEMORY`はメモリ、`SWAP`はSWAPの使用率が閾値を超えたこと。
 *
 * **どちらも超えている場合、pollerはメモリを出す。** SWAPが増えるのはメモリが足りなくなった
 * 結果なので、原因の側を出した方が「何を畳めばよいか」に繋がる。
 */
export type DispatchHostLaunchHoldReason = "MEMORY" | "SWAP";

/**
 * メモリ・SWAPが逼迫しているため、pollerが新しいセッションの起動ジョブを見送っている（#2095）。
 *
 * **使用率（`DispatchHostMetrics`）と違い、これは画面へ出すための写しであると同時に、
 * その巡のpollerの実際の動きそのもの。** 見送っている間pollerは`maxJobs: 0`でclaimし、
 * 起動ジョブを取りに行かない（停止・追加指示などの制御ジョブは従来どおり取る）。
 *
 * **判定はpoller側にある**（`DISPATCH_MEMORY_HOLD_PERCENT`・`DISPATCH_SWAP_HOLD_PERCENT`）。
 * issue-deck側で閾値を持って判定し直さない。閾値はホストの搭載メモリで決まる性質のもので、
 * `maxSessions`と同じくサブPCの`dispatch.env`が正（2か所に持つと必ずずれる）。
 *
 * `null`は「見送っていない」か「見送りを申告しない古いpoller」。**区別しない**のは、
 * どちらも「見送りの説明を出さない」という同じ扱いでよいため。
 */
export type DispatchHostLaunchHold = {
  reason: DispatchHostLaunchHoldReason;
  /** 見送りの判断に使った使用率（0〜100）。同じ巡の`metrics`と同じ値 */
  percent: number;
  /** 超えた閾値（0〜100） */
  thresholdPercent: number;
};

/**
 * pollerが送ってきた`launchHold`を検証する。**1つでも外れたら全体を`null`にする**
 * （`parseDispatchHostMetrics`と同じ向き）。
 *
 * 部分的に採用すると「理由は分かるが割合が0%」のような、読んでも判断できない表示になる。
 */
export function parseDispatchHostLaunchHold(value: unknown): DispatchHostLaunchHold | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;

  const reason = input.reason;
  if (reason !== "MEMORY" && reason !== "SWAP") return null;

  const percent = parseFinite(input.percent, 100);
  const thresholdPercent = parseFinite(input.thresholdPercent, 100);
  if (percent === null || thresholdPercent === null) return null;

  return { reason, percent, thresholdPercent };
}

/** 見送りの理由に出す名前。使用率のメーターのラベル（`describeDispatchHostMetrics`）と揃える */
function formatLaunchHoldReason(reason: DispatchHostLaunchHoldReason): string {
  return reason === "MEMORY" ? "メモリ" : "SWAP";
}

/** 「メモリ 92%（上限 85%）」。見送りを説明する文のどこでも同じ形で出す */
export function formatLaunchHoldMetric(hold: DispatchHostLaunchHold): string {
  return `${formatLaunchHoldReason(hold.reason)} ${formatHostMetricPercent(hold.percent)}（上限 ${formatHostMetricPercent(hold.thresholdPercent)}）`;
}

/**
 * ホストのカードに出す1行（#2095）。**出せないときは`null`。**
 *
 * 出さないのは「見送っていない」と「応答していない」の2つ。後者を落とすのは使用率のメーターと
 * 同じ理由で、落ちているホストは「余力が無くて待っている」のではなく「取りに来られない」。
 * 古い見送りの理由をいまの状態として見せると、pollerが落ちていることに気付けなくなる。
 */
export function describeDispatchHostLaunchHold(host: DispatchHostView): string | null {
  if (!host.launchHold || !host.online) return null;
  return `${formatLaunchHoldMetric(host.launchHold)}のため、新しいセッションの起動を見送っています`;
}
