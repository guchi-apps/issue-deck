import { describe, expect, it } from "vitest";

import { buildExpiryNoticePayload, isExpiryNoticeDue } from "@/lib/review-agent/expiry-notice";

const now = new Date("2026-11-24T00:00:00Z");
const day = 86_400_000;
const token = (offsetDays: number, revoked = false) => ({
  id: "t1",
  name: "AIDE",
  expiresAt: new Date(now.getTime() + offsetDays * day),
  revokedAt: revoked ? now : null,
});

describe("外部エージェント用トークンの期限予告", () => {
  it("14日以内と切れて間もないものだけが対象", () => {
    expect(isExpiryNoticeDue(token(30), now)).toBe(false);
    expect(isExpiryNoticeDue(token(14), now)).toBe(true);
    expect(isExpiryNoticeDue(token(-1), now)).toBe(true);
    expect(isExpiryNoticeDue(token(-8), now)).toBe(false);
    expect(isExpiryNoticeDue(token(3, true), now)).toBe(false);
  });

  it("通知文に残り日数と切れた旨を出す", () => {
    expect(buildExpiryNoticePayload(token(3), now).title).toContain("3日以内");
    expect(buildExpiryNoticePayload(token(-1), now).title).toContain("切れています");
  });
});
