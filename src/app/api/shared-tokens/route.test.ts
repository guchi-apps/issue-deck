import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const findUnique = vi.fn();
const createUsage = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    sharedToken: {
      get findUnique() {
        return findUnique;
      },
      get create() {
        return create;
      },
      get update() {
        return update;
      },
    },
    sharedTokenUsage: {
      get create() {
        return createUsage;
      },
    },
  },
}));

vi.mock("@/lib/crypto/secret-cipher", () => ({
  encryptSecret: (value: string) => `encrypted:${value}`,
  decryptSecret: (value: string) => value.replace(/^encrypted:/, ""),
}));

const { GET, POST, PUT } = await import("./route");

function request(path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) {
  return new NextRequest(`http://localhost${path}`, init);
}

describe("共有トークンAPI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHARED_TOKEN_API_SECRET = "shared-secret";
  });

  it("未設定の認証値を503で区別する", async () => {
    delete process.env.SHARED_TOKEN_API_SECRET;
    const res = await GET(request("/api/shared-tokens?name=TOKEN"));
    expect(res.status).toBe(503);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("不正なBearer値を401で拒否する", async () => {
    const res = await GET(
      request("/api/shared-tokens?name=TOKEN", { headers: { authorization: "Bearer wrong" } }),
    );
    expect(res.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("取得時に利用元を記録し、暗号化前の値だけを返す", async () => {
    findUnique.mockResolvedValue({ id: "token-1", name: "TOKEN", encryptedValue: "encrypted:value" });
    createUsage.mockResolvedValue({});

    const res = await GET(
      request("/api/shared-tokens?name=TOKEN", {
        headers: {
          authorization: "Bearer shared-secret",
          "x-shared-token-consumer": "example-app",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "TOKEN", value: "value" });
    expect(createUsage).toHaveBeenCalledWith({
      data: { sharedTokenId: "token-1", consumer: "example-app", action: "read" },
    });
  });

  it("AIエージェントも認証済みなら登録でき、応答へ値を含めない", async () => {
    create.mockResolvedValue({ id: "token-1", name: "TOKEN" });
    const res = await POST(
      request("/api/shared-tokens", {
        method: "POST",
        headers: {
          authorization: "Bearer shared-secret",
          "content-type": "application/json",
          "x-shared-token-consumer": "ai-agent",
        },
        body: JSON.stringify({ name: "TOKEN", value: "secret-value" }),
      }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "token-1", name: "TOKEN" });
    expect(create).toHaveBeenCalledWith({
      data: {
        name: "TOKEN",
        encryptedValue: "encrypted:secret-value",
        description: null,
        sourceReference: null,
        usages: { create: { consumer: "ai-agent", action: "create" } },
      },
    });
  });

  const putRequest = (body: unknown) =>
    request("/api/shared-tokens", {
      method: "PUT",
      headers: {
        authorization: "Bearer shared-secret",
        "content-type": "application/json",
        "x-shared-token-consumer": "status-hub",
      },
      body: JSON.stringify(body),
    });

  it("PUTは既存の値を上書きし、操作updateを記録する（説明は省略時に保つ）", async () => {
    findUnique.mockResolvedValue({ id: "token-1", name: "TOKEN" });
    update.mockResolvedValue({ id: "token-1", name: "TOKEN" });
    const res = await PUT(putRequest({ name: "TOKEN", value: "new-value" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "token-1", name: "TOKEN" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: {
        encryptedValue: "encrypted:new-value",
        usages: { create: { consumer: "status-hub", action: "update" } },
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("PUTは無ければ作成する", async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ id: "token-2", name: "NEW" });
    const res = await PUT(putRequest({ name: "NEW", value: "v" }));

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "NEW",
        usages: { create: { consumer: "status-hub", action: "create" } },
      }),
    });
  });
});
