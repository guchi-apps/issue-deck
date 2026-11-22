import { describe, expect, it } from "vitest";

import { formatDispatchHostName, sortDispatchHosts } from "@/lib/dispatch/host-label";

describe("formatDispatchHostName", () => {
  it("`subpc`は「サブPC」として出す（#1416）", () => {
    expect(formatDispatchHostName("subpc")).toBe("サブPC");
  });

  it("`macmini`は「MacMini」として出す（#5528）", () => {
    expect(formatDispatchHostName("macmini")).toBe("MacMini");
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

describe("sortDispatchHosts（#5569）", () => {
  it("サブPCを先頭にし、残りは名前順に並べる", () => {
    const names = sortDispatchHosts([{ name: "macmini" }, { name: "subpc" }, { name: "alpha" }]).map((h) => h.name);
    expect(names).toEqual(["subpc", "alpha", "macmini"]);
  });

  it("元の配列を変更しない", () => {
    const hosts = [{ name: "macmini" }, { name: "subpc" }];
    sortDispatchHosts(hosts);
    expect(hosts.map((h) => h.name)).toEqual(["macmini", "subpc"]);
  });
});
