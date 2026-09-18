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
      nextWindowRunEnabled: update.nextWindowRunEnabled ?? false,
      nextWindowRunLeadMinutes: update.nextWindowRunLeadMinutes ?? 60,
      nextWindowRunIntervalMinutes: update.nextWindowRunIntervalMinutes ?? 10,
    }));
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("有効／無効だけを切り替えられる（開始時刻は触らない）", async () => {
    const response = await PATCH(request({ nightly: { enabled: true } }));

    expect(response.status).toBe(200);
    expect(upsert.mock.calls[0][0].update).toEqual({ nightlyRunEnabled: true });
    expect(await response.json()).toEqual({
      nightly: { enabled: true, startHour: 1 },
      nextWindow: { enabled: false, leadMinutes: 60, intervalMinutes: 10 },
    });
  });

  it("開始時刻は夜のあいだ（22〜5時）だけ受け付ける", async () => {
    expect((await PATCH(request({ nightly: { startHour: 22 } }))).status).toBe(200);
    expect((await PATCH(request({ nightly: { startHour: 13 } }))).status).toBe(400);
    expect((await PATCH(request({ nightly: { startHour: "1" } }))).status).toBe(400);
  });

  /** #2995 */
  it("次枠実行の設定だけを切り替えられる（夜間実行は触らない）", async () => {
    const response = await PATCH(
      request({ nextWindow: { enabled: true, leadMinutes: 90, intervalMinutes: 0 } }),
    );

    expect(response.status).toBe(200);
    expect(upsert.mock.calls[0][0].update).toEqual({
      nextWindowRunEnabled: true,
      nextWindowRunLeadMinutes: 90,
      nextWindowRunIntervalMinutes: 0,
    });
  });

  /** #2995: 選べる値だけを受ける（自由入力にすると枠の終わり際という意味が崩れる） */
  it("残り時間・間隔は決まった選択肢だけ受け付ける", async () => {
    expect((await PATCH(request({ nextWindow: { leadMinutes: 7 } }))).status).toBe(400);
    expect((await PATCH(request({ nextWindow: { intervalMinutes: 7 } }))).status).toBe(400);
    expect((await PATCH(request({ nextWindow: { enabled: "true" } }))).status).toBe(400);
  });

  it("何も指定しなければ400", async () => {
    expect((await PATCH(request({}))).status).toBe(400);
    expect((await PATCH(request({ nightly: {}, nextWindow: {} }))).status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  /** #2441 */
  it("プレビュー環境では403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await PATCH(request({ nightly: { enabled: true } }));

    expect(response.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });
});
