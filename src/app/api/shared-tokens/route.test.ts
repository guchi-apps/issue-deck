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

  it("POSTで値を省略するとランダム値を生成して保存し、生成した値をその応答でだけ返す", async () => {
    create.mockResolvedValue({ id: "token-2", name: "AUTO" });
    const res = await POST(
      request("/api/shared-tokens", {
        method: "POST",
        headers: {
          authorization: "Bearer shared-secret",
          "content-type": "application/json",
          "x-shared-token-consumer": "ai-agent",
        },
        body: JSON.stringify({ name: "AUTO" }),
      }),
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as { generatedValue: string };
    expect(json.generatedValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(create.mock.calls[0][0].data.encryptedValue).toBe(`encrypted:${json.generatedValue}`);
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

  it("PUTは値の省略（自動生成）を400で拒否する", async () => {
    const res = await PUT(putRequest({ name: "TOKEN" }));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
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

  it("ログイン判定用トークンはStatusHub以外の利用元からPUT/POSTで書けない（#4164）", async () => {
    const headers = {
      authorization: "Bearer shared-secret",
      "content-type": "application/json",
      "x-shared-token-consumer": "example-app",
    };
    const body = JSON.stringify({ name: "ISSUE_DECK_ACCESS_APP_TOKEN", value: "bad" });
    const put = await PUT(request("/api/shared-tokens", { method: "PUT", headers, body }));
    const post = await POST(request("/api/shared-tokens", { method: "POST", headers, body }));
    expect(put.status).toBe(403);
    expect(post.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("ログイン判定用トークンはStatusHubの再発行経路からPUTできる", async () => {
    findUnique.mockResolvedValue({ id: "token-3", name: "ISSUE_DECK_ACCESS_APP_TOKEN" });
    update.mockResolvedValue({ id: "token-3", name: "ISSUE_DECK_ACCESS_APP_TOKEN" });
    const res = await PUT(putRequest({ name: "ISSUE_DECK_ACCESS_APP_TOKEN", value: "v" }));
    expect(res.status).toBe(200);
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
