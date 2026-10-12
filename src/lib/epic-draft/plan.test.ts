import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPlanView: vi.fn(), savePlan: vi.fn() }));
vi.mock("@/lib/execution-plan/register", () => ({ getPlanView: mocks.getPlanView, savePlan: mocks.savePlan }));

import { getEpicPlanRegistrar } from "@/lib/epic-draft/plan";
import type { EpicPlanInput } from "@/lib/epic-draft/create";

const input: EpicPlanInput = {
  parent: { repo: "o/a", number: 1 },
  objective: "目的",
  completionCriteria: ["完了"],
  children: [
    { repo: "o/a", number: 2, dependsOn: [] },
    { repo: "o/b", number: 3, dependsOn: [{ repo: "o/a", number: 2, conditions: ["merged"] }] },
  ],
  changeNote: "起案時の初回登録",
};
const plan = {
  objective: "目的",
  completionCriteria: ["完了"],
  children: [
    { repository: "o/a", number: 2, dependsOn: [] },
    { repository: "o/b", number: 3, dependsOn: [{ repository: "o/a", number: 2, conditions: ["merged"] }] },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe("親子起案の計画登録（#4535への接続）", () => {
  it("未登録なら#4535の登録関数へ、リポジトリ付きの子と条件で渡す", async () => {
    mocks.getPlanView.mockResolvedValue(null);
    mocks.savePlan.mockResolvedValue({ ok: true, view: { currentVersion: 1, plan }, diff: null, warnings: [] });
    const out = await getEpicPlanRegistrar("u1")(input);
    expect(out).toMatchObject({ ok: true, version: 1 });
    expect(out.ok && out.section).toContain("o/b#3");
    expect(mocks.savePlan.mock.calls[0][0].payload.children[1].dependsOn[0]).toEqual({ repository: "o/a", number: 2, conditions: ["merged"] });
  });

  it("同じ内容が登録済みなら再登録せず成功（再開で二重登録しない）", async () => {
    mocks.getPlanView.mockResolvedValue({ currentVersion: 1, plan });
    const out = await getEpicPlanRegistrar("u1")(input);
    expect(out).toMatchObject({ ok: true, version: 1 });
    expect(mocks.savePlan).not.toHaveBeenCalled();
  });

  it("別内容の計画が登録済みなら上書きせず失敗にする", async () => {
    mocks.getPlanView.mockResolvedValue({ currentVersion: 2, plan: { ...plan, children: plan.children.slice(0, 1) } });
    const out = await getEpicPlanRegistrar("u1")(input);
    expect(out.ok).toBe(false);
    expect(mocks.savePlan).not.toHaveBeenCalled();
  });

  it("検証エラーは具体的な理由つきの失敗にする（完了にならない）", async () => {
    mocks.getPlanView.mockResolvedValue(null);
    mocks.savePlan.mockResolvedValue({ ok: false, status: 422, errors: [{ path: "children[0]", message: "子Issue o/a#2は存在しません" }] });
    const out = await getEpicPlanRegistrar("u1")(input);
    expect(out).toMatchObject({ ok: false, message: expect.stringContaining("存在しません") });
  });
});
