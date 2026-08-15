import { describe, expect, it } from "vitest";

import { formatDateTime, formatDateTimeFull } from "@/lib/format-date-time";

// ローカルタイムで解釈させるためタイムゾーン指定なしで生成する。
const AT = new Date(2026, 7, 15, 9, 5, 0).toISOString();

describe("formatDateTime", () => {
  it("月日と時分を返す", () => {
    expect(formatDateTime(AT)).toBe("8月15日 09:05");
  });

  it("時分は2桁に揃える", () => {
    expect(formatDateTime(new Date(2026, 0, 3, 0, 0, 0).toISOString())).toBe("1月3日 00:00");
  });

  // 表示の途中で例外を投げると、その行だけでなく状態表示全体が消える
  it("解釈できない値は空文字を返す", () => {
    expect(formatDateTime("not-a-date")).toBe("");
  });
});

describe("formatDateTimeFull", () => {
  it("年まで含む日時を返す", () => {
    expect(formatDateTimeFull(AT)).toContain("2026");
  });

  it("解釈できない値は空文字を返す", () => {
    expect(formatDateTimeFull("not-a-date")).toBe("");
  });
});
