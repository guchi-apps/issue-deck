import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const createUsage = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { sharedToken: { findUnique }, sharedTokenUsage: { create: createUsage } },
}));
vi.mock("@/lib/crypto/secret-cipher", () => ({
  decryptSecret: (cipher: string) => {
    if (cipher === "broken") throw new Error("bad cipher");
    return `plain:${cipher}`;
  },
}));

const { clearSharedTokenReaderCache, readSharedTokenValue, resolveSharedToken } = await import(
  "./shared-token-reader"
);

beforeEach(() => {
  clearSharedTokenReaderCache();
  createUsage.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readSharedTokenValue", () => {
  it("DBから復号して返し、利用元issue-deckの記録を残す", async () => {
    findUnique.mockResolvedValue({ id: "t1", encryptedValue: "abc" });

    await expect(readSharedTokenValue("OPS_API_TOKEN")).resolves.toBe("plain:abc");
    expect(createUsage).toHaveBeenCalledWith({
      data: { sharedTokenId: "t1", consumer: "issue-deck", action: "read" },
    });
  });

  it("キャッシュ期間中はDBを読まず、記録も増やさない", async () => {
    findUnique.mockResolvedValue({ id: "t1", encryptedValue: "abc" });
    const now = 1_000_000;

    await readSharedTokenValue("OPS_API_TOKEN", now);
    await readSharedTokenValue("OPS_API_TOKEN", now + 30_000);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(createUsage).toHaveBeenCalledTimes(1);

    await readSharedTokenValue("OPS_API_TOKEN", now + 61_000);
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(createUsage).toHaveBeenCalledTimes(2);
  });

  it("登録が無ければnullで、記録も残さない", async () => {
    findUnique.mockResolvedValue(null);

    await expect(readSharedTokenValue("NOPE")).resolves.toBeNull();
    expect(createUsage).not.toHaveBeenCalled();
  });

  it("復号やDBの失敗は例外にせずnullで返す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({ id: "t1", encryptedValue: "broken" });
    await expect(readSharedTokenValue("A")).resolves.toBeNull();

    findUnique.mockRejectedValue(new Error("db down"));
    await expect(readSharedTokenValue("B")).resolves.toBeNull();
  });

  it("利用記録の失敗は値の取得を妨げない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({ id: "t1", encryptedValue: "abc" });
    createUsage.mockRejectedValue(new Error("write failed"));

    await expect(readSharedTokenValue("OPS_API_TOKEN")).resolves.toBe("plain:abc");
  });
});

describe("resolveSharedToken", () => {
  it("共有トークンがあれば環境変数より優先する", async () => {
    vi.stubEnv("OPS_API_TOKEN", "env-value");
    findUnique.mockResolvedValue({ id: "t1", encryptedValue: "abc" });

    await expect(resolveSharedToken("OPS_API_TOKEN", "OPS_API_TOKEN")).resolves.toBe("plain:abc");
  });

  it("共有トークンが取れなければ環境変数へ倒す", async () => {
    vi.stubEnv("IMAGE_UPLOAD_SECRET", " env-value ");
    findUnique.mockResolvedValue(null);

    await expect(
      resolveSharedToken("ISSUE_DECK_IMAGE_UPLOAD_SECRET", "IMAGE_UPLOAD_SECRET"),
    ).resolves.toBe("env-value");
  });

  it("どちらも無ければundefined", async () => {
    vi.stubEnv("IMAGE_UPLOAD_SECRET", "");
    findUnique.mockResolvedValue(null);

    await expect(resolveSharedToken("X", "IMAGE_UPLOAD_SECRET")).resolves.toBeUndefined();
  });
});
