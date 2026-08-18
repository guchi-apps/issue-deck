import { describe, expect, it } from "vitest";

import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import {
  describeDispatchHostMetrics,
  formatHostMetricPercent,
  parseDispatchHostMetrics,
  resolveHostMetricTone,
} from "@/lib/dispatch/host-metrics";

const VALID = {
  cpuPercent: 34.2,
  memoryUsedMb: 12_698,
  memoryTotalMb: 32_650,
  diskUsedGb: 219.4,
  diskTotalGb: 468.2,
  swapUsedMb: 1_024,
  swapTotalMb: 8_192,
};

/** SWAPを申告しない古いpollerの申告（#1624） */
const { swapUsedMb: _swapUsed, swapTotalMb: _swapTotal, ...WITHOUT_SWAP } = VALID;

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 1,
    online: true,
    lastSeenAt: "2026-08-15T00:00:00.000Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    manualStepAbortCapable: null,
    planReviewCapable: null,
    selfUpdateCapable: null,
    maxSessions: 12,
    liveSessions: 6,
    metrics: VALID,
    checkout: null,
    ...overrides,
  };
}

describe("parseDispatchHostMetrics", () => {
  it("正しい申告をそのまま通す（MBは整数へ丸める）", () => {
    expect(parseDispatchHostMetrics({ ...VALID, memoryUsedMb: 12_698.6 })).toEqual({
      ...VALID,
      memoryUsedMb: 12_699,
    });
  });

  it("申告そのものが無ければnull", () => {
    expect(parseDispatchHostMetrics(undefined)).toBeNull();
    expect(parseDispatchHostMetrics(null)).toBeNull();
  });

  // 部分採用しないことがこの設計の要点。1つ欠けたぶんが0＝空きに見えるのを防ぐ
  it("1項目でも欠けていれば全体をnullにする", () => {
    const { diskTotalGb: _dropped, ...partial } = VALID;
    expect(parseDispatchHostMetrics(partial)).toBeNull();
  });

  it("数値でない・有限でない値を弾く", () => {
    expect(parseDispatchHostMetrics({ ...VALID, cpuPercent: "34" })).toBeNull();
    expect(parseDispatchHostMetrics({ ...VALID, cpuPercent: Number.NaN })).toBeNull();
    expect(parseDispatchHostMetrics({ ...VALID, memoryUsedMb: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("CPUが0〜100の外なら弾く", () => {
    expect(parseDispatchHostMetrics({ ...VALID, cpuPercent: -1 })).toBeNull();
    expect(parseDispatchHostMetrics({ ...VALID, cpuPercent: 101 })).toBeNull();
    expect(parseDispatchHostMetrics({ ...VALID, cpuPercent: 100 })).not.toBeNull();
  });

  // 総量が0だと割合を出せず、使用量が総量を超えていると目盛りが振り切れて
  // 「本当に埋まっている」状態と見分けられなくなる
  it("総量が0、または使用量が総量を超えている申告を弾く", () => {
    expect(parseDispatchHostMetrics({ ...VALID, memoryTotalMb: 0 })).toBeNull();
    expect(parseDispatchHostMetrics({ ...VALID, diskTotalGb: 0 })).toBeNull();
    expect(parseDispatchHostMetrics({ ...VALID, memoryUsedMb: VALID.memoryTotalMb + 1 })).toBeNull();
    expect(parseDispatchHostMetrics({ ...VALID, diskUsedGb: VALID.diskTotalGb + 1 })).toBeNull();
  });

  // SWAPだけは「まとめて」に含めない（#1624）。必須にすると、SWAPを申告しない古いpollerで
  // CPU・メモリ・ディスクごと消える
  it("SWAPを申告しない申告でも、他の5つは通す（SWAPは対でnull）", () => {
    expect(parseDispatchHostMetrics(WITHOUT_SWAP)).toEqual({
      ...WITHOUT_SWAP,
      swapUsedMb: null,
      swapTotalMb: null,
    });
  });

  // SWAPを持たないホスト（swapoff）の正常な申告。メモリ・ディスクと違い総量0で落とさない
  it("総量0のSWAPは通す", () => {
    expect(parseDispatchHostMetrics({ ...VALID, swapUsedMb: 0, swapTotalMb: 0 })).toMatchObject({
      swapUsedMb: 0,
      swapTotalMb: 0,
    });
  });

  it("SWAPが片方だけ・壊れている申告は全体をnullにする", () => {
    expect(parseDispatchHostMetrics({ ...WITHOUT_SWAP, swapTotalMb: 8_192 })).toBeNull();
    expect(parseDispatchHostMetrics({ ...VALID, swapUsedMb: "1024" })).toBeNull();
    expect(parseDispatchHostMetrics({ ...VALID, swapUsedMb: VALID.swapTotalMb + 1 })).toBeNull();
  });
});

describe("resolveHostMetricTone", () => {
  it("60%未満は通常、60%以上で橙、85%以上で赤", () => {
    expect(resolveHostMetricTone(0)).toBe("normal");
    expect(resolveHostMetricTone(59.9)).toBe("normal");
    expect(resolveHostMetricTone(60)).toBe("warn");
    expect(resolveHostMetricTone(84.9)).toBe("warn");
    expect(resolveHostMetricTone(85)).toBe("critical");
    expect(resolveHostMetricTone(100)).toBe("critical");
  });
});

describe("describeDispatchHostMetrics", () => {
  it("CPU・メモリ・SWAP・ディスクの4行を返す", () => {
    const rows = describeDispatchHostMetrics(host());
    expect(rows?.map((row) => row.label)).toEqual(["CPU", "メモリ", "SWAP", "ディスク"]);
  });

  it("SWAPはメモリと同じくGB表記の実数を添える", () => {
    const swap = describeDispatchHostMetrics(host())?.[2];
    expect(swap?.detail).toBe("1.0 / 8.0 GB");
    expect(Math.round(swap?.percent ?? 0)).toBe(13);
    expect(swap?.tone).toBe("normal");
  });

  // 0%のメーターでは「SWAPが空いている」と「SWAPが無い」を見分けられない（#1624）
  it("SWAPが未申告・総量0のホストではSWAPの行を出さない", () => {
    const notReported = describeDispatchHostMetrics(
      host({ metrics: { ...VALID, swapUsedMb: null, swapTotalMb: null } }),
    );
    expect(notReported?.map((row) => row.label)).toEqual(["CPU", "メモリ", "ディスク"]);

    const swapOff = describeDispatchHostMetrics(
      host({ metrics: { ...VALID, swapUsedMb: 0, swapTotalMb: 0 } }),
    );
    expect(swapOff?.map((row) => row.label)).toEqual(["CPU", "メモリ", "ディスク"]);
  });

  it("メモリはGB表記の実数を添え、割合から重さを決める", () => {
    const rows = describeDispatchHostMetrics(host());
    const memory = rows?.[1];
    expect(memory?.detail).toBe("12.4 / 31.9 GB");
    expect(Math.round(memory?.percent ?? 0)).toBe(39);
    expect(memory?.tone).toBe("normal");
  });

  it("CPUは割合そのものなので実数を添えない", () => {
    expect(describeDispatchHostMetrics(host())?.[0]).toMatchObject({
      percent: 34.2,
      detail: null,
      tone: "normal",
    });
  });

  it("使用率が高いほど重い表示になる", () => {
    const rows = describeDispatchHostMetrics(
      host({ metrics: { ...VALID, cpuPercent: 91, memoryUsedMb: 24_000 } }),
    );
    expect(rows?.[0].tone).toBe("critical");
    expect(rows?.[1].tone).toBe("warn");
  });

  // 古い数字を今の値として出さない。0%として並べると、実際には埋まっているホストが
  // 空いているように見える
  it("申告が無いホスト・応答していないホストではnullを返す", () => {
    expect(describeDispatchHostMetrics(host({ metrics: null }))).toBeNull();
    expect(describeDispatchHostMetrics(host({ online: false }))).toBeNull();
  });
});

describe("formatHostMetricPercent", () => {
  it("整数の%で出す", () => {
    expect(formatHostMetricPercent(34.2)).toBe("34%");
    expect(formatHostMetricPercent(99.6)).toBe("100%");
  });
});
