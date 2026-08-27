// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePushNotificationCleanup } from "@/hooks/use-push-notification-cleanup";
import type { Issue } from "@/types/issue";

/**
 * 用の済んだ通知を閉じる（#2407）。**閉じられるのは通知を出したService Workerだけ**なので、
 * jsdomには`registration.getNotifications()`だけを生やして、`close()`が呼ばれた通知を見る。
 * 済みかどうかの振り分けそのものは`lib/notifications/stale-push.test.ts`が持つ。
 */

function makeNotification(tag: string) {
  return { tag, close: vi.fn() };
}

/** 表示中の通知を持つService Workerを生やす。`registered: false`なら登録が無い端末 */
function setupServiceWorker(notifications: ReturnType<typeof makeNotification>[] | null) {
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () =>
        notifications === null ? undefined : { getNotifications: async () => notifications },
    },
  });
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "2195",
    number: 12,
    title: "サンプルIssue",
    state: "open",
    labels: [{ name: "00.check-user", color: "d93f0b", description: null }],
    repositoryFullName: "guchi-apps/issue-deck",
    ...overrides,
  } as unknown as Issue;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  Reflect.deleteProperty(window.navigator, "serviceWorker");
});

describe("usePushNotificationCleanup", () => {
  it("確認待ちが解けた通知だけを閉じる", async () => {
    const done = makeNotification("check-user:2195");
    const pending = makeNotification("check-user:2196");
    setupServiceWorker([done, pending]);

    renderHook(() =>
      usePushNotificationCleanup({
        issues: [makeIssue({ labels: [] }), makeIssue({ id: "2196" })],
        pullRequests: [],
      }),
    );

    await waitFor(() => expect(done.close).toHaveBeenCalled());
    expect(pending.close).not.toHaveBeenCalled();
  });

  it("Service Workerが登録されていない端末では何もしない", async () => {
    setupServiceWorker(null);

    const { result } = renderHook(() =>
      usePushNotificationCleanup({ issues: [makeIssue({ labels: [] })], pullRequests: [] }),
    );

    // 例外にならずに終わることだけを確かめる（閉じる相手がいない）
    await waitFor(() => expect(result.current).toBeUndefined());
  });

  it("表に戻ったときにも見る", async () => {
    const done = makeNotification("check-user:2195");
    setupServiceWorker([done]);

    renderHook(() =>
      usePushNotificationCleanup({ issues: [makeIssue({ labels: [] })], pullRequests: [] }),
    );
    await waitFor(() => expect(done.close).toHaveBeenCalled());

    // 回数そのものは数えない（Reactは開発時に効果を2回走らせる）。閉じる操作は
    // 何度呼んでも同じなので、戻ってきたときに見直していることだけを確かめる
    const beforeReturn = done.close.mock.calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(done.close.mock.calls.length).toBeGreaterThan(beforeReturn));
  });
});
