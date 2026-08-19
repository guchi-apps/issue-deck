import { describe, expect, it } from "vitest";

import {
  formatDateOnly,
  formatDateTime,
  formatDateTimeFull,
  formatJstWeekday,
  formatMonthDay,
  formatTimeOfDay,
  isSameJstDay,
  toJstParts,
} from "@/lib/format-date-time";

// **UTCで指定した瞬間で書く**（#1977）。ローカルタイムで組み立てると、テストを走らせる
// 環境のタイムゾーン次第で期待値が変わり、「JSTへ揃っているか」を確かめられない。
// 2026-08-15T00:05:00Z = 日本時間の2026-08-15 09:05。
const AT = "2026-08-15T00:05:00Z";

describe("toJstParts", () => {
  it("UTCの値を日本時間の各部へ分解する", () => {
    expect(toJstParts(AT)).toEqual({
      year: 2026,
      month: 8,
      day: 15,
      hour: 9,
      minute: 5,
      second: 0,
      weekday: 6, // 土曜日
    });
  });

  // UTCのままだと前日になる時刻。日付の境界が9時間ずれていないことを確かめる
  it("UTCでは前日でも日本時間の日付になる", () => {
    const parts = toJstParts("2026-08-14T20:00:00Z");
    expect(parts?.day).toBe(15);
    expect(parts?.hour).toBe(5);
  });

  it("解釈できない値はnullを返す", () => {
    expect(toJstParts("not-a-date")).toBeNull();
  });
});

describe("isSameJstDay", () => {
  it("日本時間で同じ日ならtrue", () => {
    expect(isSameJstDay("2026-08-14T15:00:00Z", "2026-08-15T14:59:00Z")).toBe(true);
  });

  it("日本時間で日をまたげばfalse", () => {
    expect(isSameJstDay("2026-08-14T14:59:00Z", "2026-08-14T15:00:00Z")).toBe(false);
  });
});

describe("formatJstWeekday", () => {
  it("日本時間の曜日を返す", () => {
    expect(formatJstWeekday(AT)).toBe("土曜日");
  });

  // UTCでは金曜日だが日本時間では土曜日
  it("日付が変わる時刻では日本時間側の曜日になる", () => {
    expect(formatJstWeekday("2026-08-14T15:00:00Z")).toBe("土曜日");
  });
});

describe("formatDateTime", () => {
  it("日本時間の月日と時分を返す", () => {
    expect(formatDateTime(AT)).toBe("8月15日 09:05");
  });

  it("時分は2桁に揃える", () => {
    expect(formatDateTime("2026-01-02T15:00:00Z")).toBe("1月3日 00:00");
  });

  // 表示の途中で例外を投げると、その行だけでなく状態表示全体が消える
  it("解釈できない値は空文字を返す", () => {
    expect(formatDateTime("not-a-date")).toBe("");
  });
});

describe("formatDateTimeFull", () => {
  it("年秒まで含む日時に日本時間であることを添える", () => {
    expect(formatDateTimeFull(AT)).toBe("2026/8/15 09:05:00（日本時間）");
  });

  it("解釈できない値は空文字を返す", () => {
    expect(formatDateTimeFull("not-a-date")).toBe("");
  });
});

describe("formatTimeOfDay", () => {
  it("日本時間の時分だけを返す", () => {
    expect(formatTimeOfDay(AT)).toBe("09:05");
  });

  it("解釈できない値は空文字を返す", () => {
    expect(formatTimeOfDay("not-a-date")).toBe("");
  });
});

describe("formatMonthDay", () => {
  it("日本時間の月日だけを返す", () => {
    expect(formatMonthDay(AT)).toBe("8/15");
  });
});

describe("formatDateOnly", () => {
  it("日本時間の年月日を返す", () => {
    expect(formatDateOnly(AT)).toBe("2026/8/15");
  });

  it("解釈できない値は空文字を返す", () => {
    expect(formatDateOnly("not-a-date")).toBe("");
  });
});
