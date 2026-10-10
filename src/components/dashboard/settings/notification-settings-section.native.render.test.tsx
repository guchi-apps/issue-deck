// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationSettingsSection } from "@/components/dashboard/settings/notification-settings-section";
import type { NativePushState } from "@/lib/native-push";

/** iOSアプリ内（UAに`IssueDeckIOS`）の通知欄（#4275）。フックは差し替え、状態と文言の対応だけを見る */

const turnOn = vi.fn();
const turnOff = vi.fn();
const openSettings = vi.fn();
const sendTest = vi.fn();
const webHook = vi.fn();

let nativeState: NativePushState;

vi.mock("@/hooks/use-push-kind-preferences", () => ({
  usePushKindPreferences: () => ({ value: null, error: null, setKindEnabled: vi.fn() }),
}));
vi.mock("@/hooks/use-push-subscription", () => ({
  usePushSubscription: (...args: unknown[]) => webHook(...args),
}));
vi.mock("@/hooks/use-native-push", () => ({
  useNativePush: () => ({
    state: nativeState,
    isSubmitting: false,
    error: null,
    message: null,
    turnOn,
    turnOff,
    openSettings,
    sendTest,
    refresh: vi.fn(),
  }),
}));

function setup(state: NativePushState) {
  nativeState = state;
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Mobile/15E148 IssueDeckIOS/1.0");
  render(<NotificationSettingsSection />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("NotificationSettingsSection（iOSアプリ内）", () => {
  it("オンならバッジとスイッチがオンで、スイッチでオフにできる", () => {
    setup("on");
    expect(screen.getByText("オン")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "この端末のプッシュ通知" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(turnOff).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "テスト通知を送る" })).toBeTruthy();
  });

  it("オフならスイッチでオンにでき、ブラウザ向けの案内は出さない", () => {
    setup("off");
    expect(screen.getByText("オフ")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "この端末のプッシュ通知" }));
    expect(turnOn).toHaveBeenCalled();
    expect(screen.queryByText(/ホーム画面に追加/)).toBeNull();
    expect(screen.queryByText(/VAPID/)).toBeNull();
  });

  it("拒否済みなら設定を開く導線を出し、スイッチは押せない", () => {
    setup("denied");
    expect(screen.getByRole("switch", { name: "この端末のプッシュ通知" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "iPhoneの設定を開く" }));
    expect(openSettings).toHaveBeenCalled();
  });

  it("確認中はオンともオフとも断定しない", () => {
    setup("checking");
    expect(screen.getByText("確認中")).toBeTruthy();
    expect(screen.queryByText("オン")).toBeNull();
    expect(screen.queryByText("オフ")).toBeNull();
  });

  it("失効なら登録し直せる", () => {
    setup("expired");
    fireEvent.click(screen.getByRole("button", { name: "登録し直す" }));
    expect(turnOn).toHaveBeenCalled();
  });
});
