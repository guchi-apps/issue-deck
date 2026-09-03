import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const upsert = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      get upsert() {
        return upsert;
      },
      get findUnique() {
        return findUnique;
      },
    },
  },
}));

import type { NextRequest } from "next/server";

import { PATCH } from "@/app/api/nightly-run/settings/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("PATCH /api/nightly-run/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    requireUserId.mockResolvedValue("user-1");
    upsert.mockImplementation(async ({ update }) => ({
      nightlyRunEnabled: update.nightlyRunEnabled ?? false,
      nightlyRunStartHour: update.nightlyRunStartHour ?? 1,
    }));
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("有効／無効だけを切り替えられる（開始時刻は触らない）", async () => {
    const response = await PATCH(request({ enabled: true }));

    expect(response.status).toBe(200);
    expect(upsert.mock.calls[0][0].update).toEqual({ nightlyRunEnabled: true });
    expect(await response.json()).toEqual({ enabled: true, startHour: 1 });
  });

  it("開始時刻は夜のあいだ（22〜5時）だけ受け付ける", async () => {
    expect((await PATCH(request({ startHour: 22 }))).status).toBe(200);
    expect((await PATCH(request({ startHour: 13 }))).status).toBe(400);
    expect((await PATCH(request({ startHour: "1" }))).status).toBe(400);
  });

  it("何も指定しなければ400", async () => {
    expect((await PATCH(request({}))).status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  /** #2441 */
  it("プレビュー環境では403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await PATCH(request({ enabled: true }));

    expect(response.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });
});
