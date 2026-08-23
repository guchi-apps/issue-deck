// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationSettingsSection } from "@/components/dashboard/settings/notification-settings-section";
import type { PushAvailability } from "@/lib/push-client";

/**
 * 見るのは**状態と文言の対応**（#838）。実際の登録はブラウザのPush API頼みで、jsdomには
 * `PushManager`も`Notification`も無いため、フックごと差し替えて画面側だけを確かめる。
 *
 * 「押せない」で終わらせないことがこの画面の要件なので、**押せない各状態で「何をすれば
 * 受け取れるか」が出ているか**をそれぞれ見る。
 */

const subscribe = vi.fn();
const unsubscribe = vi.fn();
const removeSubscription = vi.fn();
const sendTest = vi.fn();

type HookState = {
  availability: PushAvailability | null;
  permission: NotificationPermission | null;
  publicKey: string | null;
  subscriptions: { id: string; endpointKey: string; userAgent: string | null; createdAt: string }[];
  currentEndpointKey: string | null;
};

let hookState: HookState;

vi.mock("@/hooks/use-push-subscription", () => ({
  usePushSubscription: () => ({
    ...hookState,
    isLoading: false,
    isSubmitting: false,
    error: null,
    message: null,
    subscribe,
    unsubscribe,
    removeSubscription,
    sendTest,
  }),
}));

function setup(overrides: Partial<HookState> = {}) {
  hookState = {
    availability: "available",
    permission: "default",
    publicKey: "test-public-key",
    subscriptions: [],
    currentEndpointKey: null,
    ...overrides,
  };
  render(<NotificationSettingsSection />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NotificationSettingsSection", () => {
  it("未登録なら、登録するボタンを押せる", () => {
    setup();
    const button = screen.getByRole("button", { name: "この端末で受け取る" });
    expect(button).not.toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(subscribe).toHaveBeenCalled();
  });

  it("登録済みなら、停止とテスト送信に切り替わる", () => {
    setup({
      currentEndpointKey: "key-1",
      subscriptions: [
        {
          id: "sub-1",
          endpointKey: "key-1",
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0.0.0 Safari/537.36",
          createdAt: "2026-08-22T05:00:00.000Z",
        },
      ],
    });

    expect(screen.getByText("受け取り中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "この端末で受け取る" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "テスト通知を送る" }));
    expect(sendTest).toHaveBeenCalled();
    // 押した画面が表示中でも出ることを添える（#2195。出ないときの次の一手も示す）
    expect(screen.getByText(/この画面を開いたままでもOSの通知として表示されます/)).toBeTruthy();
  });

  it("iOSでタブから開いている場合、ホーム画面への追加を案内する", () => {
    setup({ availability: "needs-standalone" });
    expect(screen.getByText(/ホーム画面に追加すると受け取れます/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "この端末で受け取る" }).disabled).toBe(true);
  });

  it("ブロック済みなら、端末の設定から許可するよう案内する", () => {
    setup({ permission: "denied" });
    expect(screen.getByText(/通知がブロックされています/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "この端末で受け取る" }).disabled).toBe(true);
  });

  it("サーバーの鍵が未設定なら、使えないことと影響範囲を出す", () => {
    setup({ publicKey: null });
    expect(screen.getByText(/サーバー側の鍵が設定されていません/)).toBeTruthy();
    expect(screen.getByText("利用できません")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "この端末で受け取る" }).disabled).toBe(true);
  });

  it("他の端末の購読は一覧から外せる", () => {
    setup({
      currentEndpointKey: "key-1",
      subscriptions: [
        {
          id: "sub-1",
          endpointKey: "key-1",
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0.0.0 Safari/537.36",
          createdAt: "2026-08-22T05:00:00.000Z",
        },
        {
          id: "sub-2",
          endpointKey: "key-2",
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1",
          createdAt: "2026-08-20T12:00:00.000Z",
        },
      ],
    });

    expect(screen.getByText("（この端末）")).toBeTruthy();
    expect(screen.getByText("Safari / iPhone")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "解除" })[1]);
    expect(removeSubscription).toHaveBeenCalledWith("sub-2");
  });
});
