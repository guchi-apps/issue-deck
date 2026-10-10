import { createVerify, generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  APNS_DEVICE_TOKEN_PATTERN,
  apnsEndpoint,
  classifyApnsResponse,
  createApnsJwt,
  getApnsConfig,
  isApnsEndpoint,
} from "./apns";
import { isPushConfigured } from "./push";

const ENV_KEYS = ["APNS_KEY_P8", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_ENVIRONMENT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("getApnsConfig", () => {
  it("3値が揃っていなければnull", () => {
    process.env.APNS_KEY_ID = "ABC";
    expect(getApnsConfig()).toBeNull();
  });

  it("環境は既定が本番で、sandboxだけ切り替わる", () => {
    process.env.APNS_KEY_P8 = "k\\nk";
    process.env.APNS_KEY_ID = "ABC";
    process.env.APNS_TEAM_ID = "TEAM";
    expect(getApnsConfig()?.environment).toBe("production");
    expect(getApnsConfig()?.keyPem).toBe("k\nk");
    process.env.APNS_ENVIRONMENT = "sandbox";
    expect(getApnsConfig()?.environment).toBe("sandbox");
  });
});

describe("isPushConfigured", () => {
  it("VAPIDが無くてもAPNsが設定済みなら真", () => {
    expect(isPushConfigured()).toBe(false);
    process.env.APNS_KEY_P8 = "k";
    process.env.APNS_KEY_ID = "ABC";
    process.env.APNS_TEAM_ID = "TEAM";
    expect(isPushConfigured()).toBe(true);
  });
});

describe("宛先の判定", () => {
  it("apns:接頭辞で区別する", () => {
    expect(isApnsEndpoint(apnsEndpoint("ab".repeat(32)))).toBe(true);
    expect(isApnsEndpoint("https://example.com/x")).toBe(false);
  });

  it("端末トークンは16進だけ受け付ける", () => {
    expect(APNS_DEVICE_TOKEN_PATTERN.test("ab".repeat(32))).toBe(true);
    expect(APNS_DEVICE_TOKEN_PATTERN.test("zz".repeat(32))).toBe(false);
    expect(APNS_DEVICE_TOKEN_PATTERN.test("ab/../")).toBe(false);
    expect(APNS_DEVICE_TOKEN_PATTERN.test("a".repeat(201))).toBe(false);
  });
});

describe("classifyApnsResponse", () => {
  it("失効（消す）は410とUnregisteredだけ。BadDeviceTokenは消さない", () => {
    expect(classifyApnsResponse(200, null)).toEqual({ kind: "sent" });
    expect(classifyApnsResponse(410, "Unregistered")).toEqual({ kind: "gone" });
    expect(classifyApnsResponse(400, "BadDeviceToken").kind).toBe("failed");
    expect(classifyApnsResponse(503, null).kind).toBe("failed");
  });
});

describe("createApnsJwt", () => {
  it("ES256で署名され、公開鍵で検証できる", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const config = {
      keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      keyId: "KEYID",
      teamId: "TEAMID",
      environment: "production" as const,
    };
    const jwt = createApnsJwt(config, 1_700_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEYID" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "TEAMID", iat: 1_700_000_000 });
    const ok = createVerify("SHA256")
      .update(`${header}.${claims}`)
      .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });
});
