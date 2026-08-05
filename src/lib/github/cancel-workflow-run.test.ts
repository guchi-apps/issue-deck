import { describe, expect, it } from "vitest";

import { FORCE_CANCEL_AVAILABLE_AFTER_MS, isForceCancelAvailable } from "@/lib/github/cancel-workflow-run";

const REQUESTED_AT_MS = new Date(2026, 7, 4, 12, 0, 0).getTime();

describe("isForceCancelAvailable", () => {
  it("閾値未満の経過時間ではfalseを返す", () => {
    expect(isForceCancelAvailable(REQUESTED_AT_MS, REQUESTED_AT_MS + FORCE_CANCEL_AVAILABLE_AFTER_MS - 1)).toBe(
      false,
    );
  });

  it("閾値ちょうどでtrueを返す", () => {
    expect(isForceCancelAvailable(REQUESTED_AT_MS, REQUESTED_AT_MS + FORCE_CANCEL_AVAILABLE_AFTER_MS)).toBe(
      true,
    );
  });

  it("閾値を超えた経過時間ではtrueを返す", () => {
    expect(isForceCancelAvailable(REQUESTED_AT_MS, REQUESTED_AT_MS + FORCE_CANCEL_AVAILABLE_AFTER_MS + 60_000)).toBe(
      true,
    );
  });

  it("任意の閾値を指定できる", () => {
    expect(isForceCancelAvailable(REQUESTED_AT_MS, REQUESTED_AT_MS + 1000, 500)).toBe(true);
  });
});
