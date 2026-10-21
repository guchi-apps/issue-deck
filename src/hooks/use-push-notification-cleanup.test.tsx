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
  Reflect.deleteProperty(window, "webkit");
  vi.restoreAllMocks();
});

/**
 * iOSアプリ（#4921）。UAに`IssueDeckIOS`を入れ、`issueDeckPush`ハンドラを生やす。
 * `deliveredTags`が`null`なら、その操作を持たない古いビルド（失敗を返す）
 */
function setupNativeApp(deliveredTags: string[] | null) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 IssueDeckIOS");
  const postMessage = vi.fn(async (message: { action: string; tags?: string[] }) => {
    if (message.action === "deliveredTags") {
      if (deliveredTags === null) throw new Error("unsupported");
      return deliveredTags;
    }
    if (message.action === "removeDelivered") return null;
    throw new Error("unsupported");
  });
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: { messageHandlers: { issueDeckPush: { postMessage } } },
  });
  return postMessage;
}

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

  describe("iOSアプリ内", () => {
    it("確認待ちが解けた通知だけをネイティブの通知センターから消す", async () => {
      const postMessage = setupNativeApp(["check-user:2195", "check-user:2196", "test"]);
      const getRegistration = vi.fn();
      Object.defineProperty(window.navigator, "serviceWorker", {
        configurable: true,
        value: { getRegistration },
      });

      renderHook(() =>
        usePushNotificationCleanup({
          issues: [makeIssue({ labels: [] }), makeIssue({ id: "2196" })],
          pullRequests: [],
        }),
      );

      await waitFor(() =>
        expect(postMessage).toHaveBeenCalledWith({
          action: "removeDelivered",
          tags: ["check-user:2195"],
        }),
      );
      // アプリ内ではService Workerを見ない（APNsの通知はそこに無い）
      expect(getRegistration).not.toHaveBeenCalled();
    });

    it("済んだ通知が無ければ消す操作を呼ばない", async () => {
      const postMessage = setupNativeApp(["check-user:2196"]);

      renderHook(() =>
        usePushNotificationCleanup({ issues: [makeIssue({ id: "2196" })], pullRequests: [] }),
      );

      await waitFor(() =>
        expect(postMessage).toHaveBeenCalledWith({ action: "deliveredTags" }),
      );
      expect(postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "removeDelivered" }),
      );
    });

    it("操作を持たない古いビルドでは何もしない", async () => {
      const postMessage = setupNativeApp(null);

      renderHook(() =>
        usePushNotificationCleanup({ issues: [makeIssue({ labels: [] })], pullRequests: [] }),
      );

      await waitFor(() =>
        expect(postMessage).toHaveBeenCalledWith({ action: "deliveredTags" }),
      );
      expect(postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "removeDelivered" }),
      );
    });

    it("アプリが前面へ戻った合図でも見直す", async () => {
      const postMessage = setupNativeApp(["check-user:2195"]);

      renderHook(() =>
        usePushNotificationCleanup({ issues: [makeIssue({ labels: [] })], pullRequests: [] }),
      );
      await waitFor(() =>
        expect(postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ action: "removeDelivered" }),
        ),
      );

      const before = postMessage.mock.calls.length;
      window.dispatchEvent(new Event("issue-deck:native-push-refresh"));
      await waitFor(() => expect(postMessage.mock.calls.length).toBeGreaterThan(before));
    });
  });
});
