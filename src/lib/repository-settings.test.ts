import { describe, expect, it } from "vitest";
import { parseAutoRetryLimit } from "@/lib/repository-settings";

describe("parseAutoRetryLimit", () => {
  it("範囲内の整数はそのまま返す", () => {
    expect(parseAutoRetryLimit(0)).toBe(0);
    expect(parseAutoRetryLimit(3)).toBe(3);
    expect(parseAutoRetryLimit(10)).toBe(10);
  });

  it("範囲外の整数はnullを返す", () => {
    expect(parseAutoRetryLimit(-1)).toBeNull();
    expect(parseAutoRetryLimit(11)).toBeNull();
  });

  it("整数でない値はnullを返す", () => {
    expect(parseAutoRetryLimit(1.5)).toBeNull();
    expect(parseAutoRetryLimit("3")).toBeNull();
    expect(parseAutoRetryLimit(null)).toBeNull();
    expect(parseAutoRetryLimit(undefined)).toBeNull();
  });
});
