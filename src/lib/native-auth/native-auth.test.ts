import { afterEach, describe, expect, it } from "vitest";

import { decryptSession, encryptSession } from "./cipher";
import { consumeHandoff, issueHandoff, type HandoffRecord, type HandoffStore } from "./handoff";
import { hashToken, isValidChallenge, isValidVerifier, s256Challenge } from "./tokens";

function memoryStore() {
  const rows = new Map<string, HandoffRecord & { used: boolean }>();
  const store: HandoffStore = {
    async create(r) {
      rows.set(r.codeHash, { ...r, used: false });
    },
    async claim(codeHash, purpose, now) {
      const r = rows.get(codeHash);
      if (!r || r.used || r.purpose !== purpose || r.expiresAt <= now) return null;
      r.used = true;
      return { challengeHash: r.challengeHash, sessionCipher: r.sessionCipher, next: r.next };
    },
  };
  return { store, rows };
}

const verifier = "a".repeat(64);
const challenge = s256Challenge(verifier);
const now = new Date("2026-10-10T00:00:00Z");

describe("ログインの引き継ぎ", () => {
  it("PKCEの形: verifierは43〜128文字、challengeはS256の43文字", () => {
    expect(isValidVerifier(verifier)).toBe(true);
    expect(isValidVerifier("short")).toBe(false);
    expect(isValidChallenge(challenge)).toBe(true);
    expect(isValidChallenge(verifier)).toBe(false);
  });

  it("発行したコードはverifierと一緒なら一度だけ消費でき、DBには平文のコードを置かない", async () => {
    const { store, rows } = memoryStore();
    const code = await issueHandoff({ store, challenge, sessionCipher: "cipher", next: "/", now });
    expect(rows.has(code)).toBe(false);
    expect(rows.has(hashToken(code))).toBe(true);
    expect(await consumeHandoff({ store, code, verifier, now })).toEqual({ sessionCipher: "cipher", next: "/" });
    expect(await consumeHandoff({ store, code, verifier, now })).toBeNull();
  });

  it("verifier不一致・期限切れ・未知のコードは拒否し、不一致でもコードは燃える", async () => {
    const { store } = memoryStore();
    const code = await issueHandoff({ store, challenge, sessionCipher: "c", next: null, now });
    expect(await consumeHandoff({ store, code, verifier: "b".repeat(64), now })).toBeNull();
    expect(await consumeHandoff({ store, code, verifier, now })).toBeNull();

    const late = await issueHandoff({ store, challenge, sessionCipher: "c", next: null, now });
    expect(await consumeHandoff({ store, code: late, verifier, now: new Date(now.getTime() + 61_000) })).toBeNull();
    expect(await consumeHandoff({ store, code: "unknown", verifier, now })).toBeNull();
  });
});

describe("セッションの暗号化", () => {
  const original = process.env.GITHUB_USER_TOKEN_ENCRYPTION_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.GITHUB_USER_TOKEN_ENCRYPTION_KEY;
    else process.env.GITHUB_USER_TOKEN_ENCRYPTION_KEY = original;
  });

  it("往復でき、平文を含まず、鍵が違う・無いときは失敗する", () => {
    process.env.GITHUB_USER_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    const plain = JSON.stringify({ accessToken: "a.b.c", refreshToken: "r" });
    const cipher = encryptSession(plain);
    expect(cipher).not.toContain("a.b.c");
    expect(decryptSession(cipher)).toBe(plain);
    expect(encryptSession(plain)).not.toBe(cipher);

    process.env.GITHUB_USER_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
    expect(() => decryptSession(cipher)).toThrow();
    delete process.env.GITHUB_USER_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSession(plain)).toThrow();
  });
});
