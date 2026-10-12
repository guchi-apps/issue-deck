import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findRepositoryByFullName: vi.fn(), githubForUser: vi.fn(), registerPlan: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/github/issue-create-service", () => ({ findRepositoryByFullName: mocks.findRepositoryByFullName, createIssueForUser: vi.fn() }));
vi.mock("@/lib/epic-draft/github", () => ({ githubForUser: mocks.githubForUser }));
vi.mock("@/lib/epic-draft/plan", () => ({ getEpicPlanRegistrar: () => mocks.registerPlan }));

import { executeConfirmedCard } from "@/lib/chat/handlers";
import type { ChatConfirmCard } from "@/lib/chat/types";

const user = { id: "u1", githubAccessToken: "x", githubRefreshToken: null };
const card: ChatConfirmCard = {
  type: "confirm_epic",
  repo: "o/a",
  draft: {
    parent: { repo: "o/a", title: "親", objective: "目的", completionCriteria: ["完了"], scope: "" },
    children: [
      { key: "c1", repo: "o/a", title: "子1", body: "b1", dependsOn: [] },
      { key: "c2", repo: "o/a", title: "子2", body: "b2", dependsOn: [{ key: "c1", conditions: ["merged"] }] },
    ],
  },
};

function memoryGithub() {
  const issues: { number: number; id: number; state: "open"; body: string | null }[] = [];
  return {
    issues,
    github: {
      listIssues: async () => issues.map((i) => ({ ...i })),
      createIssue: async (_r: string, input: { body: string }) => {
        const created = { number: 10 + issues.length, id: issues.length + 1, state: "open" as const, body: input.body };
        issues.push(created);
        return { number: created.number, id: created.id };
      },
      updateBody: async (_r: string, n: number, body: string) => {
        issues.find((i) => i.number === n)!.body = body;
      },
      listSubIssues: async () => [],
      addSubIssue: async () => {},
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRepositoryByFullName.mockResolvedValue({ id: "r1" });
});

describe("Chatの親子Issue確認カード（#4537）", () => {
  it("実行すると親子を作り、同じカードの押し直しで増やさない。子の開始はしない", async () => {
    const m = memoryGithub();
    mocks.githubForUser.mockReturnValue(m.github);
    mocks.registerPlan.mockResolvedValue({ ok: true, version: 1 });
    const first = await executeConfirmedCard(user, card, { requestKey: "chat-m1" });
    expect(first.ok).toBe(true);
    expect(first.text).toContain("子の実装は始まっていません");
    expect(m.issues).toHaveLength(3);
    const again = await executeConfirmedCard(user, card, { requestKey: "chat-m1" });
    expect(again.ok).toBe(true);
    expect(m.issues).toHaveLength(3);
  });

  it("計画登録に失敗したら失敗として返し、押し直すと不足分だけ続ける", async () => {
    const m = memoryGithub();
    mocks.githubForUser.mockReturnValue(m.github);
    mocks.registerPlan.mockResolvedValueOnce({ ok: false, message: "検証失敗" });
    const failed = await executeConfirmedCard(user, card, { requestKey: "chat-m2" });
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain("完了していません");
    expect(m.issues).toHaveLength(3);
    mocks.registerPlan.mockResolvedValue({ ok: true, version: 1 });
    const retried = await executeConfirmedCard(user, card, { requestKey: "chat-m2" });
    expect(retried.ok).toBe(true);
    expect(m.issues).toHaveLength(3);
  });

  it("権限外のリポジトリの子があれば何も作らない", async () => {
    const m = memoryGithub();
    mocks.githubForUser.mockReturnValue(m.github);
    mocks.findRepositoryByFullName.mockImplementation(async (_u: string, repo: string) => (repo === "o/a" ? { id: "r1" } : null));
    const bad: ChatConfirmCard = { ...card, draft: { ...card.draft, children: [card.draft.children[0], { ...card.draft.children[1], repo: "x/y" }] } } as ChatConfirmCard;
    const out = await executeConfirmedCard(user, bad, { requestKey: "chat-m3" });
    expect(out.ok).toBe(false);
    expect(m.issues).toHaveLength(0);
  });
});
