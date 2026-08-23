// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  describePushDeliveryState,
  describePushDevice,
  detectPushAvailability,
  urlBase64ToArrayBuffer,
} from "@/lib/push-client";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * `detectPushAvailability`が見るものだけを持つ偽のwindow。実物のjsdomは
 * `PushManager`を持たないため、そのままでは「対応している」経路を通せない。
 */
function makeWindow(options: {
  userAgent: string;
  standalone?: boolean;
  displayModeStandalone?: boolean;
  hasPushApi?: boolean;
  maxTouchPoints?: number;
}): Window {
  const win = {
    navigator: {
      userAgent: options.userAgent,
      maxTouchPoints: options.maxTouchPoints ?? 0,
      standalone: options.standalone,
      ...(options.hasPushApi === false ? {} : { serviceWorker: {} }),
    },
    matchMedia: () => ({ matches: options.displayModeStandalone === true }),
  } as unknown as Window;
  if (options.hasPushApi !== false) {
    (win as unknown as Record<string, unknown>).PushManager = function PushManager() {};
    (win as unknown as Record<string, unknown>).Notification = function Notification() {};
  }
  return win;
}

describe("detectPushAvailability", () => {
  it("Push APIが揃っていれば登録できる", () => {
    expect(detectPushAvailability(makeWindow({ userAgent: CHROME_LINUX_UA }))).toBe("available");
  });

  it("Push APIが無いブラウザは未対応", () => {
    expect(
      detectPushAvailability(makeWindow({ userAgent: CHROME_LINUX_UA, hasPushApi: false })),
    ).toBe("unsupported");
  });

  it("iPhoneでSafariのタブから開いている場合は「ホーム画面に追加が必要」と分けて返す", () => {
    // API自体は存在するのに subscribe() だけが失敗するため、「未対応」と一緒にすると
    // ホーム画面に追加すれば使えることが画面から読み取れない
    expect(detectPushAvailability(makeWindow({ userAgent: IPHONE_UA }))).toBe("needs-standalone");
  });

  it("iPhoneでもホーム画面から開いていれば登録できる", () => {
    expect(
      detectPushAvailability(makeWindow({ userAgent: IPHONE_UA, standalone: true })),
    ).toBe("available");
  });

  it("iPadOS（Macintoshを名乗る）もタッチの有無で見分ける", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
    expect(detectPushAvailability(makeWindow({ userAgent: ua, maxTouchPoints: 5 }))).toBe(
      "needs-standalone",
    );
    // 本物のMacは分岐に入らない
    expect(detectPushAvailability(makeWindow({ userAgent: ua }))).toBe("available");
  });
});

describe("describePushDevice", () => {
  it("ブラウザとOSの組みで端末を言い当てる", () => {
    expect(describePushDevice(CHROME_LINUX_UA)).toBe("Chrome / Linux");
    expect(describePushDevice(IPHONE_UA)).toBe("Safari / iPhone");
  });

  it("分からないものは「不明な端末」にする（当てにいかない）", () => {
    expect(describePushDevice(null)).toBe("不明な端末");
    expect(describePushDevice("something-else")).toBe("不明な端末");
  });
});

describe("urlBase64ToArrayBuffer", () => {
  it("base64urlの記号（-・_）とパディング無しを受け付ける", () => {
    // "\xfb\xff\xbe" を base64url にしたもの（標準base64なら "+/++"）
    const bytes = new Uint8Array(urlBase64ToArrayBuffer("-_--"));
    expect(Array.from(bytes)).toEqual([251, 255, 190]);
  });
});

/**
 * 通知とトーストの出し分け（#2196）。**「届いている」と言い切れるときだけ`delivering`**で、
 * それ以外は画面内のトーストが出る側へ倒す——両方消えて何も知らされない状態を作らないため。
 */
describe("describePushDeliveryState", () => {
  it("ブラウザとサーバーの両方に購読があり、許可も出ていれば届いている", () => {
    expect(
      describePushDeliveryState({
        permission: "granted",
        browserEndpointKey: "key-1",
        serverEndpointKeys: ["key-0", "key-1"],
      }),
    ).toBe("delivering");
  });

  it("ブラウザにあってサーバーに無ければ失効（送信時の404/410で消された状態）", () => {
    expect(
      describePushDeliveryState({
        permission: "granted",
        browserEndpointKey: "key-1",
        serverEndpointKeys: ["key-2"],
      }),
    ).toBe("expired");
  });

  it("購読していなければオフ", () => {
    expect(
      describePushDeliveryState({
        permission: "granted",
        browserEndpointKey: null,
        serverEndpointKeys: ["key-1"],
      }),
    ).toBe("off");
  });

  it("購読が残っていても、通知が許可されていなければオフ（OSが出さない）", () => {
    expect(
      describePushDeliveryState({
        permission: "denied",
        browserEndpointKey: "key-1",
        serverEndpointKeys: ["key-1"],
      }),
    ).toBe("off");
  });

  it("サーバー側を取れていないうちは判断しない（トーストを出す側へ倒す）", () => {
    expect(
      describePushDeliveryState({
        permission: "granted",
        browserEndpointKey: "key-1",
        serverEndpointKeys: null,
      }),
    ).toBe("unknown");
  });
});
