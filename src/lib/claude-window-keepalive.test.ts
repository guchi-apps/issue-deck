import { describe, expect, it } from "vitest";

import {
  CLAUDE_WINDOW_KEEPALIVE_RETRY_MS,
  decideClaudeWindowKeepAlive,
  describeClaudeWindowKeepAlive,
  isWithinClaudeWindowKeepAliveHours,
  resolveClaudeWindowRunningUntil,
  type ClaudeWindowKeepAliveView,
} from "@/lib/claude-window-keepalive";

/** 日本時間の`HH:mm`（2026-09-18）をDateにする */
function jst(time: string): Date {
  return new Date(`2026-09-18T${time}:00+09:00`);
}

const ON = { enabled: true, startHour: 7, endHour: 23 };

describe("isWithinClaudeWindowKeepAliveHours（#3032）", () => {
  it("開始は含み、終了ちょうどは含まない（日本時間で判定する）", () => {
    expect(isWithinClaudeWindowKeepAliveHours(ON, jst("06:59"))).toBe(false);
    expect(isWithinClaudeWindowKeepAliveHours(ON, jst("07:00"))).toBe(true);
    expect(isWithinClaudeWindowKeepAliveHours(ON, jst("22:59"))).toBe(true);
    expect(isWithinClaudeWindowKeepAliveHours(ON, jst("23:00"))).toBe(false);
  });

  it("開始＞終了は日付をまたぐ", () => {
    const overnight = { startHour: 22, endHour: 6 };
    expect(isWithinClaudeWindowKeepAliveHours(overnight, jst("23:30"))).toBe(true);
    expect(isWithinClaudeWindowKeepAliveHours(overnight, jst("05:59"))).toBe(true);
    expect(isWithinClaudeWindowKeepAliveHours(overnight, jst("12:00"))).toBe(false);
  });

  it("開始＝終了は終日", () => {
    expect(isWithinClaudeWindowKeepAliveHours({ startHour: 0, endHour: 0 }, jst("03:00"))).toBe(true);
  });
});

describe("decideClaudeWindowKeepAlive（#3032）", () => {
  const now = jst("10:00");

  it("OFF・時間帯の外では送らない", () => {
    expect(
      decideClaudeWindowKeepAlive({
        settings: { ...ON, enabled: false },
        now,
        knownResetsAt: null,
        lastProbedAt: null,
      }),
    ).toEqual({ action: "skip", reason: "off" });
    expect(
      decideClaudeWindowKeepAlive({ settings: ON, now: jst("23:30"), knownResetsAt: null, lastProbedAt: null }),
    ).toEqual({ action: "skip", reason: "outside_hours" });
  });

  it("枠が動いている間（リセット前）は送らない", () => {
    expect(
      decideClaudeWindowKeepAlive({
        settings: ON,
        now,
        knownResetsAt: jst("11:00").getTime(),
        lastProbedAt: null,
      }),
    ).toEqual({ action: "skip", reason: "window_open" });
  });

  it("リセット時刻を過ぎた・未取得なら送る", () => {
    expect(
      decideClaudeWindowKeepAlive({
        settings: ON,
        now,
        knownResetsAt: jst("09:59").getTime(),
        lastProbedAt: jst("05:00"),
      }),
    ).toEqual({ action: "probe" });
    expect(
      decideClaudeWindowKeepAlive({ settings: ON, now, knownResetsAt: null, lastProbedAt: null }),
    ).toEqual({ action: "probe" });
  });

  /** 取得に失敗し続けても、pollerの巡回（30秒）ごとには送らない */
  it("直前に送ったばかりなら間を空ける", () => {
    const lastProbedAt = new Date(now.getTime() - CLAUDE_WINDOW_KEEPALIVE_RETRY_MS + 1000);
    expect(
      decideClaudeWindowKeepAlive({ settings: ON, now, knownResetsAt: null, lastProbedAt }),
    ).toEqual({ action: "skip", reason: "recently_probed" });
  });
});

describe("resolveClaudeWindowRunningUntil", () => {
  it("未来のリセット時刻だけを動いている枠として返す", () => {
    const now = jst("10:00");
    expect(resolveClaudeWindowRunningUntil(jst("13:40").getTime(), now)?.toISOString()).toBe(
      jst("13:40").toISOString(),
    );
    expect(resolveClaudeWindowRunningUntil(jst("09:00").getTime(), now)).toBeNull();
    expect(resolveClaudeWindowRunningUntil(null, now)).toBeNull();
  });
});

describe("describeClaudeWindowKeepAlive", () => {
  function view(overrides: Partial<ClaudeWindowKeepAliveView> = {}): ClaudeWindowKeepAliveView {
    return { settings: ON, withinHours: true, probedAt: null, runningUntil: null, ...overrides };
  }

  it("OFFのときは枠の話をしない", () => {
    expect(describeClaudeWindowKeepAlive(view({ settings: { ...ON, enabled: false } }))).toMatch(/^OFFです/);
  });

  it("時間帯の外なら開始時刻を案内する", () => {
    expect(describeClaudeWindowKeepAlive(view({ withinHours: false }))).toBe(
      "いまは時間帯の外です（7:00〜23:00）。7:00以降の最初の巡回で枠を開けます。",
    );
  });

  it("枠が動いていればリセット時刻を出す", () => {
    expect(describeClaudeWindowKeepAlive(view({ runningUntil: jst("13:40").toISOString() }))).toBe(
      "7:00〜23:00のあいだ、枠が止まっていれば最小のリクエストで開けます。いまの枠は13:40にリセットし、その後の巡回で次の枠を開けます。",
    );
  });

  it("枠が止まっていれば次の巡回で開けると出す", () => {
    expect(describeClaudeWindowKeepAlive(view())).toMatch(/サブPCの次の巡回で開けます。$/);
  });
});
