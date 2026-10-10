import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, update, decideAccess } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  decideAccess: vi.fn(),
}));
vi.mock("@/lib/access/client", () => ({ decideAccess }));
vi.mock("@/lib/db", () => ({ db: { shareToken: { findUnique, update } } }));

import { authenticateShareToken } from "./auth";
import { issueShareTokenValue } from "./token";

const future = new Date(Date.now() + 60_000);

describe("共有トークンの検証", () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset().mockResolvedValue({});
    decideAccess.mockReset().mockResolvedValue({ allowed: true, permissions: [] });
  });

  it("有効なトークンは持ち主を返す", async () => {
    const { value, hash } = issueShareTokenValue();
    findUnique.mockResolvedValue({ id: "t1", expiresAt: future, revokedAt: null, user: { id: "u1", supabaseUserId: "s1", email: "a@example.com" } });
    await expect(authenticateShareToken(`Bearer ${value}`)).resolves.toEqual({ id: "u1", supabaseUserId: "s1", email: "a@example.com" });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: hash } }));
  });

  it("許可リストから外れた利用者は、有効なトークンでも通さない", async () => {
    const { value } = issueShareTokenValue();
    findUnique.mockResolvedValue({
      id: "t1", expiresAt: future, revokedAt: null, emailVerified: true,
      user: { id: "u1", supabaseUserId: "s1", email: "a@example.com" },
    });
    decideAccess.mockResolvedValue({ allowed: false, permissions: [] });
    expect(await authenticateShareToken(`Bearer ${value}`)).toBeNull();
    expect(decideAccess).toHaveBeenCalledWith({ sub: "s1", email: "a@example.com", emailVerified: true });
  });

  it("失効・期限切れ・未登録・形式違いは通さない", async () => {
    const { value } = issueShareTokenValue();
    findUnique.mockResolvedValue({ id: "t1", expiresAt: future, revokedAt: new Date(), user: { id: "u1", supabaseUserId: "s1", email: "a@example.com" } });
    expect(await authenticateShareToken(`Bearer ${value}`)).toBeNull();
    findUnique.mockResolvedValue({ id: "t1", expiresAt: new Date(Date.now() - 1), revokedAt: null, user: { id: "u1", supabaseUserId: "s1", email: "a@example.com" } });
    expect(await authenticateShareToken(`Bearer ${value}`)).toBeNull();
    findUnique.mockResolvedValue(null);
    expect(await authenticateShareToken(`Bearer ${value}`)).toBeNull();
    expect(await authenticateShareToken("Bearer other")).toBeNull();
    expect(await authenticateShareToken(null)).toBeNull();
  });
});
