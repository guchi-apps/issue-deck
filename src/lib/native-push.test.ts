import { describe, expect, it } from "vitest";

import { describeNativePushState, isNativeApp, type NativePushStatus } from "@/lib/native-push";

const status = (overrides: Partial<NativePushStatus> = {}): NativePushStatus => ({
  permission: "authorized",
  enabled: true,
  token: "abc",
  ...overrides,
});

describe("describeNativePushState", () => {
  it("許可・受信設定・登録がそろえばオン", () => {
    expect(describeNativePushState({ status: status(), serverEndpointKeys: ["k"], tokenEndpointKey: "k" })).toBe("on");
  });

  it("状態が取れていない間は断定しない", () => {
    expect(describeNativePushState({ status: null, serverEndpointKeys: [], tokenEndpointKey: null })).toBe("checking");
    expect(describeNativePushState({ status: status(), serverEndpointKeys: null, tokenEndpointKey: "k" })).toBe("checking");
  });

  it("OSで拒否されていればdenied（受信設定がオンでも）", () => {
    expect(describeNativePushState({ status: status({ permission: "denied" }), serverEndpointKeys: ["k"], tokenEndpointKey: "k" })).toBe("denied");
  });

  it("受信設定オフ・未選択はオフ", () => {
    expect(describeNativePushState({ status: status({ enabled: false }), serverEndpointKeys: ["k"], tokenEndpointKey: "k" })).toBe("off");
    expect(describeNativePushState({ status: status({ permission: "notDetermined", token: null }), serverEndpointKeys: [], tokenEndpointKey: null })).toBe("off");
  });

  it("トークン未取得は登録中、サーバーに無ければ失効", () => {
    expect(describeNativePushState({ status: status({ token: null }), serverEndpointKeys: [], tokenEndpointKey: null })).toBe("registering");
    expect(describeNativePushState({ status: status(), serverEndpointKeys: ["other"], tokenEndpointKey: "k" })).toBe("expired");
  });
});

describe("isNativeApp", () => {
  it("UAの識別子で判定する", () => {
    expect(isNativeApp("Mozilla/5.0 Mobile/15E148 IssueDeckIOS/1.0")).toBe(true);
    expect(isNativeApp("Mozilla/5.0 Safari/605.1.15")).toBe(false);
  });
});
