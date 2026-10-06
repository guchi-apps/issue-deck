import { describe, expect, it } from "vitest";

import {
  createAccessClient,
  type AccessFetcher,
  type AccessResponse,
  type AccessSubject,
} from "@/lib/access/decision";

const subject: AccessSubject = { sub: "u1", email: "Me@Example.com", emailVerified: true };
const response = (allowed: boolean, version = 3): AccessResponse => ({
  appVersion: version,
  ttlSeconds: 30,
  maxStaleSeconds: 300,
  decision: { allowed, permissions: allowed ? ["member"] : [], reason: allowed ? undefined : "revoked" },
});

function setup(fetcher: AccessFetcher) {
  let t = 1_000_000;
  const client = createAccessClient(fetcher, undefined, () => t);
  return { client, advance: (s: number) => (t += s * 1000) };
}

describe("StatusHub判定クライアント", () => {
  it("ttlの間は使い回し、過ぎたら取り直して取り消しが効く", async () => {
    let allowed = true;
    let calls = 0;
    const { client, advance } = setup(async () => (calls++, response(allowed)));
    expect((await client.decide(subject)).allowed).toBe(true);
    allowed = false;
    advance(29);
    expect((await client.decide(subject)).allowed).toBe(true);
    expect(calls).toBe(1);
    advance(2);
    expect((await client.decide(subject)).allowed).toBe(false);
    expect(calls).toBe(2);
  });

  it("取得失敗: 5分までは直前の判定、超えたら拒否", async () => {
    let fail = false;
    const { client, advance } = setup(async () => {
      if (fail) throw new Error("down");
      return response(true);
    });
    await client.decide(subject);
    fail = true;
    advance(60);
    expect((await client.decide(subject)).allowed).toBe(true);
    advance(241);
    expect((await client.decide(subject)).allowed).toBe(false);
  });

  it("一度も判定できていない利用者は、取得失敗なら拒否", async () => {
    const { client } = setup(async () => {
      throw new Error("down");
    });
    expect((await client.decide(subject)).allowed).toBe(false);
  });

  it("メール未確認の主体は問い合わせず拒否", async () => {
    let calls = 0;
    const { client } = setup(async () => (calls++, response(true)));
    const decision = await client.decide({ ...subject, emailVerified: false });
    expect(decision).toMatchObject({ allowed: false, reason: "unverified_identity" });
    expect(calls).toBe(0);
  });

  it("ハートビートは判定なしで版を申告する", async () => {
    const bodies: unknown[] = [];
    const { client } = setup(async (body) => (bodies.push(body), response(true, 7)));
    await client.decide(subject);
    expect(await client.heartbeat()).toBe(true);
    expect(bodies[1]).toEqual({ appliedVersion: 7 });
  });
});
