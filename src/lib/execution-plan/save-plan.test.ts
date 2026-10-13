import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  versionCreate: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    executionPlan: { updateMany: mocks.updateMany },
    executionPlanVersion: { create: mocks.versionCreate },
  };
  return {
    db: {
      executionPlan: { findUnique: mocks.findUnique, create: mocks.create },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

import { savePlan, type VerifyDeps } from "@/lib/execution-plan/register";

const parent = { repository: "guchi-apps/issue-deck", number: 100 };
const snapshot = {
  objective: "o",
  completionCriteria: ["c"],
  children: [{ repository: parent.repository, number: 1, dependsOn: [] }],
};
const deps: VerifyDeps = {
  tokenFor: async () => "t",
  issueState: async () => "open",
  branchPrs: async () => ({ kind: "none" }),
  subIssues: async () => [],
};

function existingRow() {
  return {
    id: "p1",
    parentRepository: parent.repository,
    parentIssue: parent.number,
    currentVersion: 1,
    boundVersion: null,
    versions: [{ version: 1, snapshot, changeNote: "n", author: "a", createdAt: new Date() }],
  };
}

describe("savePlan（更新）", () => {
  beforeEach(() => vi.resetAllMocks());

  it("版の作成に失敗したら、版を進める更新と同じトランザクション内で失敗が伝わる", async () => {
    mocks.findUnique.mockResolvedValue(existingRow());
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.versionCreate.mockRejectedValue(new Error("db down"));
    await expect(
      savePlan({ parent, payload: snapshot, author: "a", changeNote: "更新", expectedVersion: 1, deps }),
    ).rejects.toThrow("db down");
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it("更新後の計画から外す子がクローズ済みなら、confirmRemoveがあっても外せない", async () => {
    mocks.findUnique.mockResolvedValue(existingRow());
    const next = { ...snapshot, children: [{ repository: parent.repository, number: 2, dependsOn: [] }] };
    const r = await savePlan({
      parent,
      payload: next,
      author: "a",
      changeNote: "更新",
      expectedVersion: 1,
      confirmRemove: [`${parent.repository}#1`],
      deps: { ...deps, issueState: async (ref) => (ref.number === 1 ? "closed" : "open") },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.includes("完了済みの成果なので計画から外せません"))).toBe(true);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("外す子の状態を取得できなければ、完了済みか判断できないので外せない", async () => {
    mocks.findUnique.mockResolvedValue(existingRow());
    const next = { ...snapshot, children: [{ repository: parent.repository, number: 2, dependsOn: [] }] };
    const r = await savePlan({
      parent,
      payload: next,
      author: "a",
      changeNote: "更新",
      expectedVersion: 1,
      confirmRemove: [`${parent.repository}#1`],
      deps: {
        ...deps,
        issueState: async (ref) => {
          if (ref.number === 1) throw new Error("HTTP 502");
          return "open";
        },
      },
    });
    expect(r.ok).toBe(false);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("同時更新で版を進められなければ409を返し、版を作らない", async () => {
    mocks.findUnique.mockResolvedValue(existingRow());
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const r = await savePlan({ parent, payload: snapshot, author: "a", changeNote: "更新", expectedVersion: 1, deps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(mocks.versionCreate).not.toHaveBeenCalled();
  });
});
