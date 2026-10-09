import { afterEach, describe, expect, it, vi } from "vitest";

import { parseWakeTargets, sendWake, signWake } from "@/lib/dispatch/wake-notify";

import * as receiver from "../../../scripts/lib/dispatch-wake-protocol.mjs";

describe("parseWakeTargets", () => {
  it("ホスト単位に複数の宛先を読み、不正な行は捨てる", () => {
    const targets = parseWakeTargets(
      "subpc=http://100.64.0.1:4290, mac=http://100.64.0.2:4290,bad,x=https://a:1,y=http://u:p@a:1,z=http://a:1/path",
    );
    expect([...targets.keys()]).toEqual(["subpc", "mac"]);
    expect(targets.get("subpc")).toBe("http://100.64.0.1:4290");
  });
  it("未設定は空", () => {
    expect(parseWakeTargets(undefined).size).toBe(0);
  });
});

describe("署名", () => {
  it("送り手と受け手で同じ値になり、検証が通る", () => {
    const sig = signWake("secret", "subpc", 1_700_000_000_000);
    expect(sig).toBe(receiver.signWake("secret", "subpc", 1_700_000_000_000));
    const ok = receiver.verifyWake({ dispatchSecret: "secret", hostName: "subpc", timestamp: "1700000000000", signature: sig, nowMs: 1_700_000_005_000 });
    expect(ok.ok).toBe(true);
  });
  it("別ホスト宛・期限切れ・鍵違い・形式不正は拒否する", () => {
    const sig = signWake("secret", "subpc", 1_700_000_000_000);
    const base = { dispatchSecret: "secret", hostName: "subpc", timestamp: "1700000000000", signature: sig, nowMs: 1_700_000_000_000 };
    expect(receiver.verifyWake({ ...base, hostName: "mac" }).ok).toBe(false);
    expect((receiver.verifyWake({ ...base, nowMs: 1_700_000_100_000 }) as { reason?: string }).reason).toBe("expired");
    expect(receiver.verifyWake({ ...base, dispatchSecret: "other" }).ok).toBe(false);
    expect(receiver.verifyWake({ ...base, signature: "zz" }).ok).toBe(false);
    expect(receiver.verifyWake({ ...base, timestamp: undefined }).ok).toBe(false);
    expect((receiver.verifyWake({ ...base, dispatchSecret: "" }) as { reason?: string }).reason).toBe("not_configured");
  });
});

describe("sendWake", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("対象外ホスト・未設定では送らない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("DISPATCH_SECRET", "secret");
    vi.stubEnv("DISPATCH_WAKE_TARGETS", "subpc=http://100.64.0.1:4290");
    expect(await sendWake("other")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("署名付きで本文なしのPOSTを送り、通信断は例外にせずfalseを返す", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("DISPATCH_SECRET", "secret");
    vi.stubEnv("DISPATCH_WAKE_TARGETS", "subpc=http://100.64.0.1:4290");
    expect(await sendWake("subpc", () => 1_700_000_000_000)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://100.64.0.1:4290/wake");
    expect(init.body).toBeUndefined();
    expect(init.headers["x-wake-signature"]).toBe(signWake("secret", "subpc", 1_700_000_000_000));
    expect(await sendWake("subpc")).toBe(false);
  });
});
