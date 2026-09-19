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
      nextWindowRunEnabled: update.nextWindowRunEnabled ?? false,
      nextWindowRunLeadMinutes: update.nextWindowRunLeadMinutes ?? 60,
      nextWindowRunIntervalMinutes: update.nextWindowRunIntervalMinutes ?? 10,
      nextWindowRunFiveHourFloorPercent: update.nextWindowRunFiveHourFloorPercent ?? 0,
      nextWindowRunWeeklyFloorPercent: update.nextWindowRunWeeklyFloorPercent ?? 0,
      claudeWindowKeepAliveEnabled: update.claudeWindowKeepAliveEnabled ?? false,
      claudeWindowKeepAliveStartHour: update.claudeWindowKeepAliveStartHour ?? 7,
      claudeWindowKeepAliveEndHour: update.claudeWindowKeepAliveEndHour ?? 23,
    }));
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("有効／無効だけを切り替えられる", async () => {
    const response = await PATCH(request({ nextWindow: { enabled: true } }));

    expect(response.status).toBe(200);
    expect(upsert.mock.calls[0][0].update).toEqual({ nextWindowRunEnabled: true });
    expect(await response.json()).toEqual({
      nextWindow: {
        enabled: true,
        leadMinutes: 60,
        intervalMinutes: 10,
        fiveHourFloorPercent: 0,
        weeklyFloorPercent: 0,
      },
      keepAlive: { enabled: false, startHour: 7, endHour: 23 },
    });
  });

  /** #3032 */
  it("5時間枠を開けておく設定を切り替えられる", async () => {
    const response = await PATCH(
      request({ keepAlive: { enabled: true, startHour: 22, endHour: 6 } }),
    );

    expect(response.status).toBe(200);
    expect(upsert.mock.calls[0][0].update).toEqual({
      claudeWindowKeepAliveEnabled: true,
      claudeWindowKeepAliveStartHour: 22,
      claudeWindowKeepAliveEndHour: 6,
    });
    expect((await response.json()).keepAlive).toEqual({ enabled: true, startHour: 22, endHour: 6 });
  });

  it("時間帯は0〜23の整数だけ受け付ける", async () => {
    expect((await PATCH(request({ keepAlive: { startHour: 24 } }))).status).toBe(400);
    expect((await PATCH(request({ keepAlive: { endHour: 7.5 } }))).status).toBe(400);
    expect((await PATCH(request({ keepAlive: { enabled: 1 } }))).status).toBe(400);
  });

  /** #2995 */
  it("次枠実行の設定を切り替えられる", async () => {
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

  /** #3100 */
  it("残り枠の下限を切り替えられる", async () => {
    const response = await PATCH(
      request({ nextWindow: { fiveHourFloorPercent: 10, weeklyFloorPercent: 20 } }),
    );

    expect(response.status).toBe(200);
    expect(upsert.mock.calls[0][0].update).toEqual({
      nextWindowRunFiveHourFloorPercent: 10,
      nextWindowRunWeeklyFloorPercent: 20,
    });
    expect((await response.json()).nextWindow).toMatchObject({
      fiveHourFloorPercent: 10,
      weeklyFloorPercent: 20,
    });
  });

  it("下限は決まった選択肢（0・10〜50%）だけ受け付ける", async () => {
    expect((await PATCH(request({ nextWindow: { weeklyFloorPercent: 15 } }))).status).toBe(400);
    expect((await PATCH(request({ nextWindow: { weeklyFloorPercent: 100 } }))).status).toBe(400);
    expect((await PATCH(request({ nextWindow: { fiveHourFloorPercent: -10 } }))).status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  /** #2995: 選べる値だけを受ける（自由入力にすると枠の終わり際という意味が崩れる） */
  it("残り時間・間隔は決まった選択肢だけ受け付ける", async () => {
    expect((await PATCH(request({ nextWindow: { leadMinutes: 7 } }))).status).toBe(400);
    expect((await PATCH(request({ nextWindow: { intervalMinutes: 7 } }))).status).toBe(400);
    expect((await PATCH(request({ nextWindow: { enabled: "true" } }))).status).toBe(400);
  });

  it("何も指定しなければ400", async () => {
    expect((await PATCH(request({}))).status).toBe(400);
    expect((await PATCH(request({ nextWindow: {} }))).status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  /** #2441 */
  it("プレビュー環境では403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await PATCH(request({ nextWindow: { enabled: true } }));

    expect(response.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });
});
