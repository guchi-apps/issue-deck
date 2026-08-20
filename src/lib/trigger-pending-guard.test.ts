import { describe, expect, it } from "vitest";

import { RELEASE_TRIGGER_PENDING_MS, isTriggerPending } from "@/lib/trigger-pending-guard";

const NOW = new Date("2026-08-15T12:00:00Z").getTime();

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("isTriggerPending", () => {
  it("起動していなければ押せる", () => {
    expect(isTriggerPending(null, NOW)).toBe(false);
    expect(isTriggerPending(undefined, NOW)).toBe(false);
  });

  it("起動直後は押せない", () => {
    expect(isTriggerPending(isoAgo(0), NOW)).toBe(true);
    expect(isTriggerPending(isoAgo(60_000), NOW)).toBe(true);
  });

  it("既定の待ち時間を過ぎたら押せる（バンプPRが作られなかった場合の逃げ道）", () => {
    expect(isTriggerPending(isoAgo(RELEASE_TRIGGER_PENDING_MS - 1), NOW)).toBe(true);
    expect(isTriggerPending(isoAgo(RELEASE_TRIGGER_PENDING_MS), NOW)).toBe(false);
    expect(isTriggerPending(isoAgo(RELEASE_TRIGGER_PENDING_MS + 1), NOW)).toBe(false);
  });

  it("待ち時間は呼び出し側で変えられる", () => {
    expect(isTriggerPending(isoAgo(5_000), NOW, 10_000)).toBe(true);
    expect(isTriggerPending(isoAgo(15_000), NOW, 10_000)).toBe(false);
  });

  it("時刻として読めない値は押せる側へ倒す（保存内容が壊れていても操作を塞がない）", () => {
    expect(isTriggerPending("あとで", NOW)).toBe(false);
  });

  it("未来の時刻は押せない側へ倒す（端末の時計がずれている場合）", () => {
    expect(isTriggerPending(new Date(NOW + 60_000).toISOString(), NOW)).toBe(true);
  });
});
