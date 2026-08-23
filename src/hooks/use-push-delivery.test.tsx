// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PUSH_DELIVERY_RECHECK_INTERVAL_MS,
  usePushDeliveryState,
} from "@/hooks/use-push-delivery";
import { pushEndpointKeyInBrowser } from "@/lib/push-client";
import { notifyPushSubscriptionChanged } from "@/lib/push-subscription-change";

/**
 * トーストを止めてよいかの判定（#2196）。**「届いている」と言い切れるときだけ`delivering`**で、
 * それ以外は画面内のトーストが出る側へ倒す——通知もトーストも出ない状態を作らないため。
 *
 * jsdomは`PushManager`も`Notification`も`serviceWorker`も持たないので、判定が見る3つ
 * （ブラウザ側の購読・許可・サーバー側の行）だけを生やして動かす。
 */

const ENDPOINT = "https://push.example.test/endpoint-1";

let getSubscription: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function setupBrowser(options: {
  /** ブラウザ側に購読があるか */
  subscribed: boolean;
  permission?: NotificationPermission;
}) {
  getSubscription = vi.fn(async () =>
    options.subscribed ? { endpoint: ENDPOINT } : null,
  );
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => ({ pushManager: { getSubscription } }) },
  });
  Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission: options.permission ?? "granted" },
  });
}

/** サーバーが持っている購読の一覧を返す（`fail`のときは取得に失敗させる） */
function setupServer(endpointKeys: string[] | "fail") {
  fetchMock = vi.fn(async () =>
    endpointKeys === "fail"
      ? ({ ok: false, status: 500 } as Response)
      : ({
          ok: true,
          json: async () => ({ subscriptions: endpointKeys.map((key) => ({ endpointKey: key })) }),
        } as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  // 取り直しの間隔（5分）を待たずに進めるため。`waitFor`が実時間に頼らないよう
  // `shouldAdvanceTime`を立てる
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setupBrowser({ subscribed: true });
  setupServer([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("usePushDeliveryState", () => {
  it("サーバー側にも同じ購読があれば、届いている（＝トーストを出さない）", async () => {
    setupServer([await pushEndpointKeyInBrowser(ENDPOINT)]);
    const { result } = renderHook(() => usePushDeliveryState());
    await waitFor(() => expect(result.current).toBe("delivering"));
  });

  it("ブラウザにあってサーバーに無ければ失効として扱う（トーストで補う）", async () => {
    setupServer(["別の端末のキー"]);
    const { result } = renderHook(() => usePushDeliveryState());
    await waitFor(() => expect(result.current).toBe("expired"));
  });

  it("購読していない端末は、サーバーへ問い合わせずにオフと判定する", async () => {
    setupBrowser({ subscribed: false });
    const { result } = renderHook(() => usePushDeliveryState());
    await waitFor(() => expect(result.current).toBe("off"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("購読が残っていても、通知を許可していなければオフ", async () => {
    setupBrowser({ subscribed: true, permission: "denied" });
    const { result } = renderHook(() => usePushDeliveryState());
    await waitFor(() => expect(result.current).toBe("off"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("サーバー側を取れなければ判断しない（トーストが出る側へ倒す）", async () => {
    setupServer("fail");
    const { result } = renderHook(() => usePushDeliveryState());
    await waitFor(() => expect(result.current).toBe("unknown"));
  });

  it("開いたまま失効したら、取り直して気づく（送信時の404/410で購読行が消える）", async () => {
    const key = await pushEndpointKeyInBrowser(ENDPOINT);
    setupServer([key]);
    const { result } = renderHook(() => usePushDeliveryState());
    await waitFor(() => expect(result.current).toBe("delivering"));

    // サーバー側だけが消えた状態にして、次の取り直しを待つ
    setupServer([]);
    await act(async () => {
      vi.advanceTimersByTime(PUSH_DELIVERY_RECHECK_INTERVAL_MS);
    });
    await waitFor(() => expect(result.current).toBe("expired"));
  });

  it("設定画面で登録し直したら、そのまま引き直す", async () => {
    const { result } = renderHook(() => usePushDeliveryState());
    await waitFor(() => expect(result.current).toBe("expired"));

    // 登録し直した後の状態にしてから合図を出す
    setupServer([await pushEndpointKeyInBrowser(ENDPOINT)]);
    notifyPushSubscriptionChanged();
    await waitFor(() => expect(result.current).toBe("delivering"));
  });
});
