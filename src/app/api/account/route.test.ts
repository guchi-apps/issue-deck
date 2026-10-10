import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUser, userDelete, createAdminClient } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  userDelete: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/auth-user", () => ({ getCurrentUser }));
vi.mock("@/lib/db", () => ({ db: { user: { delete: userDelete } } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { DELETE, GET } from "./route";

describe("DELETE /api/account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未認証は401で、何も削除しない", async () => {
    getCurrentUser.mockResolvedValue(null);

    const res = await DELETE();

    expect(res.status).toBe(401);
    expect(userDelete).not.toHaveBeenCalled();
  });

  it("ログイン中のアプリUserだけを削除し、共有Authユーザーは削除しない", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1", supabaseUserId: "s1" });
    const deleteUser = vi.fn();
    createAdminClient.mockReturnValue({ auth: { admin: { deleteUser } } });

    const res = await DELETE();

    expect(res.status).toBe(200);
    expect(userDelete).toHaveBeenCalledWith({ where: { id: "u1" } });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

describe("GET /api/account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未認証は401", async () => {
    getCurrentUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("ログイン中のユーザーのIDだけを返す", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1", githubAccessToken: "secret" });
    const res = await GET();
    expect(await res.json()).toEqual({ id: "u1" });
  });
});
