import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findMany = vi.fn();
const upsert = vi.fn(async () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    repository: { findFirst: (...args: unknown[]) => findFirst(...args) },
    pushSubscription: { findMany: (...args: unknown[]) => findMany(...args) },
    releaseMergePushNotice: { upsert: (...args: unknown[]) => upsert(...(args as [])) },
  },
}));
const sendPushNotification = vi.fn(async () => ({ sent: 1, removed: 0, failed: 0 }));
const isPushConfigured = vi.fn(() => true);
vi.mock("@/lib/notifications/push", () => ({
  isPushConfigured: () => isPushConfigured(),
  sendPushNotification: (...args: unknown[]) => sendPushNotification(...(args as [])),
}));

import { buildReleaseCompletionStopPushPayload, sendReleaseCompletionStopPush } from "./release-completion-stop-push";

const stop = { repositoryFullName: "o/app", pullRequestNumber: 12, publish: false, reason: "mainが進みました。\n詳細" };
const now = new Date("2026-11-11T00:00:00Z");

describe("buildReleaseCompletionStopPushPayload", () => {
  it("候補PRの詳細を開き、本番マージ待ちと同じtagでまとめる", () => {
    const payload = buildReleaseCompletionStopPushPayload(stop);
    expect(payload.title).toBe("app ・ リリース完了系列が停止");
    expect(payload.body).toBe("#12 mainが進みました。");
    expect(payload.url).toContain("pane=pull-requests");
    expect(payload.tag.startsWith("release-merge:")).toBe(true);
  });

  it("自動公開の停止と、理由が無いときの文言", () => {
    const payload = buildReleaseCompletionStopPushPayload({ ...stop, publish: true, reason: null });
    expect(payload.title).toBe("app ・ 自動公開が停止");
    expect(payload.body).toBe("#12 リリース候補の画面で理由を確認してください");
  });
});

describe("sendReleaseCompletionStopPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPushConfigured.mockReturnValue(true);
    findFirst.mockResolvedValue({ id: "repo1", installationId: "inst1" });
    findMany.mockResolvedValue([{ id: "p1", endpoint: "e", p256dh: "k", auth: "a" }]);
  });

  it("非表示・OFFを除いた宛先へ送り、巡回が鳴らし直さないよう席を取る", async () => {
    await sendReleaseCompletionStopPush(stop, now);
    const where = findMany.mock.calls[0][0].where.user;
    expect(where.userInstallations).toEqual({ some: { installationId: "inst1" } });
    expect(where.hiddenRepositories).toEqual({ none: { repositoryId: "repo1" } });
    expect(where.pushMutedKinds).toEqual({ none: { kind: "release-merge" } });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { notifiedAt: now }, create: { repositoryFullName: "o/app", pullRequestNumber: 12, notifiedAt: now } }),
    );
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it("Push未設定なら何もしない。失敗しても例外を投げない", async () => {
    isPushConfigured.mockReturnValue(false);
    await sendReleaseCompletionStopPush(stop, now);
    expect(findFirst).not.toHaveBeenCalled();
    isPushConfigured.mockReturnValue(true);
    findFirst.mockRejectedValue(new Error("db"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(sendReleaseCompletionStopPush(stop, now)).resolves.toBeUndefined();
    spy.mockRestore();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });
});
