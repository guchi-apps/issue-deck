import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    issue: {
      get findFirst() {
        return findFirst;
      },
    },
  },
}));

import { GET } from "@/app/api/issues/body/route";

function request(query = "id=123") {
  return new Request(`http://localhost/api/issues/body?${query}`) as never;
}

describe("GET /api/issues/body（#3390）", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findFirst.mockReset().mockResolvedValue({
      body: "本文",
      githubUpdatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
  });

  it("未ログインなら401を返す", async () => {
    requireUserId.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it.each(["", "id=", "id=abc", "id=-1"])("IDが不正なら400を返す（%s）", async (query) => {
    const res = await GET(request(query));
    expect(res.status).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("参照できるインストール配下に限って引き、見つからなければ404を返す", async () => {
    findFirst.mockResolvedValue(null);
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          githubIssueId: BigInt(123),
          repository: { installation: { userInstallations: { some: { userId: "user-1" } } } },
        },
      }),
    );
  });

  it("本文と版（updatedAt）を返す", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: "本文", updatedAt: "2026-01-02T00:00:00.000Z" });
  });

  it("本文がnullなら空文字を返す", async () => {
    findFirst.mockResolvedValue({ body: null, githubUpdatedAt: new Date("2026-01-02T00:00:00.000Z") });
    const res = await GET(request());
    expect(await res.json()).toEqual({ body: "", updatedAt: "2026-01-02T00:00:00.000Z" });
  });
});
