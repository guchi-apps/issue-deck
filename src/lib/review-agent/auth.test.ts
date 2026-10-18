import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ tokens: [] as Array<Record<string, unknown>>, repos: ["o/r"], audit: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/db", () => ({
  db: {
    reviewAgentToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => s.tokens.find((t) => t.tokenHash === where.tokenHash) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `id${s.tokens.length}`, revokedAt: null, ...data };
        s.tokens.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: { id: string; userId: string; expiresAt?: { gt: Date } } }) =>
        s.tokens.find((t) => t.id === where.id && t.userId === where.userId && t.revokedAt === null && (!where.expiresAt || (t.expiresAt as Date) > where.expiresAt.gt)) ?? null,
      updateMany: async ({ where, data }: { where: { id: string; userId: string; revokedAt: null; expiresAt?: { gt: Date } }; data: Record<string, unknown> }) => {
        const hit = s.tokens.filter((t) => t.id === where.id && t.userId === where.userId && t.revokedAt === null && (!where.expiresAt || (t.expiresAt as Date) > where.expiresAt.gt));
        hit.forEach((t) => Object.assign(t, data));
        return { count: hit.length };
      },
    },
    reviewAgentAuditLog: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        s.audit.push(...data);
        return { count: data.length };
      },
    },
    repository: { findMany: async ({ where }: { where: { fullName: { in: string[] } } }) => where.fullName.in.filter((n) => s.repos.includes(n)).map((fullName) => ({ fullName })) },
  },
}));

import { authenticateReviewAgent, createReviewAgentToken, revokeReviewAgentToken, updateReviewAgentTokenRepositories } from "@/lib/review-agent/auth";

beforeEach(() => {
  s.tokens = [];
  s.repos = ["o/r"];
  s.audit = [];
});
const issue = (over = {}) => createReviewAgentToken({ userId: "u1", name: "agent", scopes: ["read"], repositories: ["o/r"], expiresInDays: 7, ...over });

describe("トークン", () => {
  it("発行した値で認証でき、保存はハッシュだけ", async () => {
    const r = await issue();
    if (!r.ok) throw new Error("issue");
    expect(JSON.stringify(s.tokens)).not.toContain(r.token);
    const auth = await authenticateReviewAgent(`Bearer ${r.token}`);
    expect(auth).toMatchObject({ ok: true, principal: { userId: "u1", scopes: ["read"], repositories: ["o/r"] } });
  });
  it("無い・不正・共有シークレット形式の値は401", async () => {
    expect(await authenticateReviewAgent(null)).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await authenticateReviewAgent("Bearer shared-secret")).toMatchObject({ ok: false, code: "unauthorized" });
    expect(await authenticateReviewAgent("Bearer ida_unknown")).toMatchObject({ ok: false, code: "unauthorized" });
  });
  it("期限切れ・失効は401で理由を分ける", async () => {
    const r = await issue();
    if (!r.ok) throw new Error("issue");
    expect(await authenticateReviewAgent(`Bearer ${r.token}`, new Date(Date.now() + 8 * 86_400_000))).toMatchObject({ ok: false, code: "token_expired" });
    expect(await revokeReviewAgentToken("someone-else", r.id)).toBe(false);
    expect(await revokeReviewAgentToken("u1", r.id)).toBe(true);
    expect(await authenticateReviewAgent(`Bearer ${r.token}`)).toMatchObject({ ok: false, code: "token_revoked" });
  });
  it("連携していないrepository・全許可・範囲外の操作範囲では発行できない", async () => {
    expect(await issue({ repositories: ["o/other"] })).toMatchObject({ ok: false, code: "repository_not_found" });
    expect(await issue({ repositories: [] })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await issue({ repositories: ["*"] })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await issue({ scopes: ["admin"] })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await issue({ expiresInDays: 9999 })).toMatchObject({ ok: false, code: "invalid_request" });
  });
});

describe("許可repositoryの編集（#4739）", () => {
  it("値を変えずに追加・削除でき、すぐ反映され、変更ごとに監査が残る", async () => {
    s.repos = ["o/r", "o/new"];
    const r = await issue();
    if (!r.ok) throw new Error("issue");
    const res = await updateReviewAgentTokenRepositories("u1", r.id, ["o/new"]);
    expect(res).toMatchObject({ ok: true, added: ["o/new"], removed: ["o/r"] });
    expect(await authenticateReviewAgent(`Bearer ${r.token}`)).toMatchObject({ ok: true, principal: { repositories: ["o/new"] } });
    expect(s.audit).toEqual([
      { tool: "token_repo_add", repositoryFullName: "o/new", tokenId: r.id, userId: "u1", outcome: "ok" },
      { tool: "token_repo_remove", repositoryFullName: "o/r", tokenId: r.id, userId: "u1", outcome: "ok" },
    ]);
  });
  it("新たに加えるrepositoryが未連携なら拒否し、既存のまま残すものは連携が外れていても保存できる", async () => {
    const r = await issue();
    if (!r.ok) throw new Error("issue");
    expect(await updateReviewAgentTokenRepositories("u1", r.id, ["o/r", "o/other"])).toMatchObject({ ok: false, code: "repository_not_found" });
    s.repos = [];
    expect(await updateReviewAgentTokenRepositories("u1", r.id, ["o/r"])).toMatchObject({ ok: true, added: [], removed: [] });
  });
  it("空・全許可・他人のトークン・失効・期限切れは編集できない", async () => {
    const r = await issue();
    if (!r.ok) throw new Error("issue");
    expect(await updateReviewAgentTokenRepositories("u1", r.id, [])).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await updateReviewAgentTokenRepositories("u1", r.id, ["*"])).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await updateReviewAgentTokenRepositories("u2", r.id, ["o/r"])).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateReviewAgentTokenRepositories("u1", r.id, ["o/r"], new Date(Date.now() + 8 * 86_400_000))).toMatchObject({ ok: false, code: "not_found" });
    await revokeReviewAgentToken("u1", r.id);
    expect(await updateReviewAgentTokenRepositories("u1", r.id, ["o/r"])).toMatchObject({ ok: false, code: "not_found" });
  });
});
