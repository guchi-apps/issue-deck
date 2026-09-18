import { describe, expect, it } from "vitest";

import {
  CLAUDE_FIVE_HOUR_WINDOW_MS,
  NEXT_WINDOW_RUN_EXPIRY_HOURS,
  decideNextWindowRunLaunch,
  describeNextWindowRunMarkChip,
  describeNextWindowRunSchedule,
  formatNextWindowRunKey,
  formatNextWindowRunKeyLabel,
  resolveNextWindowRunWindow,
  type ClaudeWindowSnapshot,
} from "@/lib/next-window-run";

/** 2026-09-18 08:40 JST（＝2026-09-17 23:40 UTC）。実測のリセット時刻と同じ半端な時刻 */
const RESETS_AT = Date.UTC(2026, 8, 17, 23, 40);
const HOUR = 60 * 60_000;

function snapshot(overrides: Partial<ClaudeWindowSnapshot> = {}): ClaudeWindowSnapshot {
  return { resetsAt: RESETS_AT, usedPercent: 62, ...overrides };
}

function windowAt(nowMs: number, leadMinutes = 60) {
  return resolveNextWindowRunWindow({ snapshot: snapshot(), now: new Date(nowMs), leadMinutes });
}

describe("resolveNextWindowRunWindow", () => {
  it("枠の途中は`waiting`で、起動が始まる時刻を返す", () => {
    const window = windowAt(RESETS_AT - 3 * HOUR);
    expect(window.phase).toBe("waiting");
    expect(window.opensAt?.getTime()).toBe(RESETS_AT - HOUR);
    expect(window.resetsAt?.getTime()).toBe(RESETS_AT);
  });

  it("残りが設定した時間を切ると`open`になる", () => {
    expect(windowAt(RESETS_AT - HOUR).phase).toBe("open");
    expect(windowAt(RESETS_AT - HOUR + 1).phase).toBe("open");
    expect(windowAt(RESETS_AT - HOUR - 1).phase).toBe("waiting");
  });

  it("残り時間の設定を変えると境界も動く", () => {
    expect(windowAt(RESETS_AT - 100 * 60_000, 90).phase).toBe("waiting");
    expect(windowAt(RESETS_AT - 80 * 60_000, 90).phase).toBe("open");
  });

  it("リセット時刻を過ぎていれば`idle`（枠が動いていない）", () => {
    expect(windowAt(RESETS_AT).phase).toBe("idle");
    expect(windowAt(RESETS_AT + HOUR).phase).toBe("idle");
  });

  /**
   * #2995: 枠が動いていないときに使用量を取りに行くと、その取得リクエスト自体が枠を開始する。
   * 「残り5時間ちょうど」に見える枠は、いま開いたばかりの空の枠なのですぐ起動してよい。
   */
  it("取得した拍子に開いたばかりの枠（残りがほぼ5時間）も`idle`", () => {
    const justOpened = RESETS_AT - CLAUDE_FIVE_HOUR_WINDOW_MS + 30_000;
    expect(windowAt(justOpened).phase).toBe("idle");
    // 猶予（3分）を過ぎれば、ふつうに使われている枠として`waiting`に戻る
    expect(windowAt(RESETS_AT - CLAUDE_FIVE_HOUR_WINDOW_MS + 5 * 60_000).phase).toBe("waiting");
  });

  it("取得できていなければ`unknown`（起動しない）", () => {
    const window = resolveNextWindowRunWindow({
      snapshot: { resetsAt: null, usedPercent: null },
      now: new Date(RESETS_AT),
      leadMinutes: 60,
    });
    expect(window.phase).toBe("unknown");
    expect(window.runKey).toBeNull();
  });

  it("同じ枠のあいだは`runKey`が変わらない（結果を1回ぶんに束ねる鍵）", () => {
    expect(windowAt(RESETS_AT - 4 * HOUR).runKey).toBe("2026-09-18 08:40");
    expect(windowAt(RESETS_AT - 1).runKey).toBe("2026-09-18 08:40");
  });

  it("枠が動いていないときの`runKey`は、ここから始まる枠のリセット時刻", () => {
    const now = RESETS_AT + HOUR;
    expect(windowAt(now).runKey).toBe(formatNextWindowRunKey(now + CLAUDE_FIVE_HOUR_WINDOW_MS));
  });
});

describe("decideNextWindowRunLaunch", () => {
  const base = {
    now: new Date(RESETS_AT - 30 * 60_000),
    createdAt: new Date(RESETS_AT - 3 * HOUR),
    reservedResetsAt: null,
    lastLaunchedAt: null,
    leadMinutes: 60,
    intervalMinutes: 10,
  };

  it("枠の終わり際なら起動する", () => {
    expect(decideNextWindowRunLaunch({ ...base, phase: "open" })).toEqual({ action: "launch" });
  });

  it("枠が動いていなければ待たずに起動する", () => {
    expect(decideNextWindowRunLaunch({ ...base, phase: "idle" })).toEqual({ action: "launch" });
  });

  it("枠の途中は待つ", () => {
    expect(decideNextWindowRunLaunch({ ...base, phase: "waiting" }).action).toBe("wait");
  });

  it("枠の状況を取れていなければ待つ（見送りにはしない）", () => {
    expect(decideNextWindowRunLaunch({ ...base, phase: "unknown" }).action).toBe("wait");
  });

  /** #2995: これが「次の」枠の実体。積んだときの枠では起こさない */
  it("積んだときの枠が続いているあいだは、終わり際でも起動しない", () => {
    const decision = decideNextWindowRunLaunch({
      ...base,
      phase: "open",
      reservedResetsAt: new Date(RESETS_AT),
    });
    expect(decision.action).toBe("wait");
    // その枠が終わっていれば起動できる
    expect(
      decideNextWindowRunLaunch({
        ...base,
        phase: "open",
        now: new Date(RESETS_AT + HOUR),
        reservedResetsAt: new Date(RESETS_AT),
      }),
    ).toEqual({ action: "launch" });
  });

  it("直前の起動から間隔が空くまで待つ", () => {
    const now = new Date(RESETS_AT - 30 * 60_000);
    expect(
      decideNextWindowRunLaunch({
        ...base,
        phase: "open",
        lastLaunchedAt: new Date(now.getTime() - 5 * 60_000),
      }).action,
    ).toBe("wait");
    expect(
      decideNextWindowRunLaunch({
        ...base,
        phase: "open",
        lastLaunchedAt: new Date(now.getTime() - 11 * 60_000),
      }),
    ).toEqual({ action: "launch" });
  });

  it("間隔0なら直前に起動していても続けて起動する", () => {
    expect(
      decideNextWindowRunLaunch({
        ...base,
        phase: "open",
        intervalMinutes: 0,
        lastLaunchedAt: base.now,
      }),
    ).toEqual({ action: "launch" });
  });

  it("積んでから24時間で見送る（枠を取れないままでも残さない）", () => {
    const decision = decideNextWindowRunLaunch({
      ...base,
      phase: "unknown",
      createdAt: new Date(base.now.getTime() - NEXT_WINDOW_RUN_EXPIRY_HOURS * HOUR),
    });
    expect(decision.action).toBe("skip");
    expect(decision.action === "skip" && decision.reason).toContain("24時間");
  });
});

describe("画面に出す文言", () => {
  const settings = { enabled: true, leadMinutes: 60, intervalMinutes: 10 };

  it("OFFのときは枠の残り時間の話をしない", () => {
    const line = describeNextWindowRunSchedule({ ...settings, enabled: false }, null);
    expect(line).toContain("OFF");
    expect(line).not.toContain("リセット");
  });

  it("枠が動いていないときは「次の巡回で起動」と出す", () => {
    const line = describeNextWindowRunSchedule(settings, {
      phase: "idle",
      resetsAt: null,
      opensAt: null,
      usedPercent: null,
      runKey: null,
    });
    expect(line).toContain("動いていません");
  });

  it("目印のチップは、起動が始まる時刻・まもなく・OFFを出し分ける", () => {
    const opensAt = new Date(RESETS_AT - HOUR).toISOString();
    expect(
      describeNextWindowRunMarkChip({ entryId: "e1", enabled: true, opensAt, phase: "waiting" }),
    ).toBe("次枠 07:40〜");
    expect(
      describeNextWindowRunMarkChip({ entryId: "e1", enabled: true, opensAt, phase: "idle" }),
    ).toBe("次枠 まもなく");
    expect(
      describeNextWindowRunMarkChip({ entryId: "e1", enabled: false, opensAt, phase: "waiting" }),
    ).toBe("次枠実行OFF");
  });

  it("結果の見出しは日付と時刻に開く", () => {
    expect(formatNextWindowRunKeyLabel("2026-09-18 08:40")).toBe("9/18 08:40");
    expect(formatNextWindowRunKeyLabel("こわれた鍵")).toBe("こわれた鍵");
  });
});
