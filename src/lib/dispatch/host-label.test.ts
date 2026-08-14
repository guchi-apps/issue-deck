import { describe, expect, it } from "vitest";

import { formatDispatchHostName } from "@/lib/dispatch/host-label";

describe("formatDispatchHostName", () => {
  it("`subpc`は「サブPC」として出す（#1416）", () => {
    expect(formatDispatchHostName("subpc")).toBe("サブPC");
  });

  it("大文字小文字が揺れても同じ表記にする（`hostname`の出力に依存させない）", () => {
    expect(formatDispatchHostName("SubPC")).toBe("サブPC");
  });

  // 表示から`local-repos.conf`・DBの値を推測できる状態を保つため、知らないホストは加工しない
  it("対応表に無いホストはそのまま返す", () => {
    expect(formatDispatchHostName("otherpc")).toBe("otherpc");
    expect(formatDispatchHostName("")).toBe("");
  });
});
