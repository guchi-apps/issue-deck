import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";

import { assertPublicAddresses, fetchPublicHttps, isPublicIpAddress, publicOnlyLookup } from "@/lib/public-http-fetch";

type Resolver = Parameters<typeof publicOnlyLookup>[3];
const resolverTo =
  (...addresses: string[]): Resolver =>
  ((_host: string, _opts: unknown, cb: (err: null, a: LookupAddress[]) => void) =>
    cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))) as unknown as Resolver;

describe("isPublicIpAddress", () => {
  it("内部・予約のIPv4を拒否する", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "224.0.0.1", "255.255.255.255", "198.18.0.1"]) {
      expect(isPublicIpAddress(ip), ip).toBe(false);
    }
  });

  it("公開のIPv4を許可する（範囲の外側の境界を含む）", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1"]) {
      expect(isPublicIpAddress(ip), ip).toBe(true);
    }
  });

  it("内部・予約のIPv6（射影・NAT64・6to4を含む）を拒否する", () => {
    for (const ip of ["::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "2001:db8::1", "fec0::1"]) {
      expect(isPublicIpAddress(ip), ip).toBe(false);
    }
  });

  it("公開のIPv6を許可する", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isPublicIpAddress(ip), ip).toBe(true);
    }
  });

  it("IPでない文字列は拒否する", () => {
    expect(isPublicIpAddress("example.com")).toBe(false);
    expect(isPublicIpAddress("999.1.1.1")).toBe(false);
  });
});

describe("assertPublicAddresses", () => {
  it("1つでも内部アドレスが混ざる解決結果は拒否する", () => {
    expect(() => assertPublicAddresses([{ address: "8.8.8.8" }, { address: "127.0.0.1" }])).toThrow();
    expect(() => assertPublicAddresses([])).toThrow();
    expect(() => assertPublicAddresses([{ address: "8.8.8.8" }])).not.toThrow();
  });
});

describe("publicOnlyLookup", () => {
  const run = (resolver: Resolver, all = false) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address?: unknown }>((resolve) => publicOnlyLookup("probe.example.com", { all }, (err, address) => resolve({ err, address }), resolver));

  it("公開アドレスへ解決されたときだけ返す", async () => {
    expect((await run(resolverTo("8.8.8.8"))).address).toBe("8.8.8.8");
    expect((await run(resolverTo("8.8.8.8"), true)).address).toHaveLength(1);
  });

  it("通常のFQDNが内部アドレスへ解決されるなら拒否する", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "::ffff:192.168.0.1"]) {
      const { err } = await run(resolverTo(ip));
      expect(err?.code, ip).toBe("EBLOCKEDADDR");
    }
    expect((await run(resolverTo("8.8.8.8", "10.0.0.5"))).err?.code).toBe("EBLOCKEDADDR");
  });
});

describe("fetchPublicHttps", () => {
  const withResolver = (resolver: Resolver) => (h: string, o: { all?: boolean; family?: number }, cb: Parameters<typeof publicOnlyLookup>[2]) => publicOnlyLookup(h, o, cb, resolver);

  it("内部アドレスへ解決されるホストには接続せずに失敗する", async () => {
    await expect(fetchPublicHttps("https://probe.example.com/v", { timeoutMs: 2000, bodyLimit: 1024, lookup: withResolver(resolverTo("127.0.0.1")) })).rejects.toMatchObject({ code: "EBLOCKEDADDR" });
  });

  it("IPアドレス直書き・http・不正なURLは名前解決より前に拒否する", async () => {
    for (const url of ["https://127.0.0.1/v", "https://[::1]/v", "http://probe.example.com/v", "not a url"]) {
      await expect(fetchPublicHttps(url, { timeoutMs: 2000, bodyLimit: 1024, lookup: withResolver(resolverTo("8.8.8.8")) })).rejects.toThrow();
    }
  });
});
