import { describe, expect, it } from "vitest";

import {
  FINE_GRAINED_TOKEN_NAME_MAX_LENGTH,
  getFineGrainedTokenRemainingDays,
  getFineGrainedTokenStatus,
  parseFineGrainedTokenInput,
} from "@/lib/fine-grained-tokens";

const NOW = new Date("2026-08-08T00:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("parseFineGrainedTokenInput", () => {
  it("正常な入力はtrim・ISO文字列化して返す", () => {
    expect(parseFineGrainedTokenInput({ name: " WORKFLOW_PAT ", expiresAt: "2026-12-31" })).toEqual({
      name: "WORKFLOW_PAT",
      expiresAt: new Date("2026-12-31").toISOString(),
    });
  });

  it("空文字・最大長超過の名前はnullを返す", () => {
    expect(parseFineGrainedTokenInput({ name: "  ", expiresAt: "2026-12-31" })).toBeNull();
    expect(
      parseFineGrainedTokenInput({
        name: "a".repeat(FINE_GRAINED_TOKEN_NAME_MAX_LENGTH + 1),
        expiresAt: "2026-12-31",
      }),
    ).toBeNull();
  });

  it("不正な日付・欠損フィールドはnullを返す", () => {
    expect(parseFineGrainedTokenInput({ name: "WORKFLOW_PAT", expiresAt: "not-a-date" })).toBeNull();
    expect(parseFineGrainedTokenInput({ name: "WORKFLOW_PAT" })).toBeNull();
    expect(parseFineGrainedTokenInput(null)).toBeNull();
    expect(parseFineGrainedTokenInput("WORKFLOW_PAT")).toBeNull();
  });
});

describe("getFineGrainedTokenStatus", () => {
  it("有効期限を過ぎていればexpired", () => {
    expect(getFineGrainedTokenStatus(new Date(NOW - DAY_MS).toISOString(), NOW)).toBe("expired");
    expect(getFineGrainedTokenStatus(new Date(NOW).toISOString(), NOW)).toBe("expired");
  });

  it("残り14日以内はexpiring-soon", () => {
    expect(getFineGrainedTokenStatus(new Date(NOW + DAY_MS).toISOString(), NOW)).toBe(
      "expiring-soon",
    );
    expect(getFineGrainedTokenStatus(new Date(NOW + 14 * DAY_MS).toISOString(), NOW)).toBe(
      "expiring-soon",
    );
  });

  it("残り15日以上はactive", () => {
    expect(getFineGrainedTokenStatus(new Date(NOW + 15 * DAY_MS).toISOString(), NOW)).toBe(
      "active",
    );
  });
});

describe("getFineGrainedTokenRemainingDays", () => {
  it("残り日数を切り上げで返す", () => {
    expect(getFineGrainedTokenRemainingDays(new Date(NOW + 1.5 * DAY_MS).toISOString(), NOW)).toBe(
      2,
    );
    expect(getFineGrainedTokenRemainingDays(new Date(NOW - DAY_MS).toISOString(), NOW)).toBe(-1);
  });
});
