import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();

vi.mock("@/lib/auth-user", () => ({ requireUserId: () => requireUserId() }));
vi.mock("@/lib/db", () => ({
  db: {
    repository: { findFirst: (...args: unknown[]) => findFirst(...args) },
    branchViewRepository: {
      upsert: (...args: unknown[]) => upsert(...args),
      deleteMany: (...args: unknown[]) => deleteMany(...args),
    },
  },
}));

import { PUT } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/repositories/branch-view", {
    method: "PUT",
    body: JSON.stringify(body),
  }) as never;
}

describe("PUT /api/repositories/branch-view（#5087）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUserId.mockResolvedValue("user-1");
    findFirst.mockResolvedValue({ id: "repo-1" });
  });

  it("未ログインは401", async () => {
    requireUserId.mockResolvedValue(null);
    expect((await PUT(request({ repositoryId: "repo-1", mode: "active" }))).status).toBe(401);
  });

  it("不正なモードは400", async () => {
    expect((await PUT(request({ repositoryId: "repo-1", mode: "hidden" }))).status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("連携していないリポジトリは404", async () => {
    findFirst.mockResolvedValue(null);
    expect((await PUT(request({ repositoryId: "x", mode: "never" }))).status).toBe(404);
  });

  it("active/never は upsert で保存する", async () => {
    const response = await PUT(request({ repositoryId: "repo-1", mode: "active" }));
    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith({
      where: { userId_repositoryId: { userId: "user-1", repositoryId: "repo-1" } },
      create: { userId: "user-1", repositoryId: "repo-1", mode: "active" },
      update: { mode: "active" },
    });
  });

  it("always は既定なので行を消す", async () => {
    await PUT(request({ repositoryId: "repo-1", mode: "always" }));
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1", repositoryId: "repo-1" } });
    expect(upsert).not.toHaveBeenCalled();
  });
});
