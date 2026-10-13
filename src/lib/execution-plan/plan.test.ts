import { describe, expect, it } from "vitest";

import { detectBodyMismatch, renderPlanBody } from "@/lib/execution-plan/body";
import { diffPlans, validateReplan } from "@/lib/execution-plan/diff";
import { verifyPlanAgainstGithub, type VerifyDeps } from "@/lib/execution-plan/register";
import type { PlanSnapshot } from "@/lib/execution-plan/types";
import { computeStages, parsePlanInput } from "@/lib/execution-plan/validate";

const parent = { repository: "guchi-apps/issue-deck", number: 100 };
const R = "guchi-apps/issue-deck";
const ref = (n: number, repository = R) => ({ repository, number: n });

/** A→(B,C 並行)→D。Aはdevelopマージ後、B/Cは検証後にD */
const input = {
  objective: "計画機能を出す",
  completionCriteria: ["本番で登録・取得できる"],
  children: [
    { ...ref(1), dependsOn: [] },
    { ...ref(2), dependsOn: [{ ...ref(1), conditions: ["merged"] }] },
    { ...ref(3, "guchi-apps/vps"), dependsOn: [{ ...ref(1), conditions: ["merged"] }] },
    {
      ...ref(4),
      dependsOn: [
        { ...ref(2), conditions: ["merged", "verified"] },
        { ...ref(3, "guchi-apps/vps"), conditions: ["verified"] },
      ],
    },
  ],
};

function plan(): PlanSnapshot {
  const r = parsePlanInput(input, parent);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.plan;
}

describe("parsePlanInput", () => {
  it("並行可能な範囲を段で表せる（別リポジトリの同番号を取り違えない）", () => {
    const stages = computeStages(plan()).map((s) => s.map((c) => `${c.repository}#${c.number}`));
    expect(stages).toEqual([[`${R}#1`], [`${R}#2`, "guchi-apps/vps#3"], [`${R}#4`]]);
  });

  it("循環・自己依存・重複・不正条件・親を子にする・条件省略を全部列挙して拒む", () => {
    const bad = {
      ...input,
      children: [
        { ...ref(1), dependsOn: [{ ...ref(1), conditions: ["merged"] }] },
        { ...ref(2), dependsOn: [{ ...ref(2), conditions: ["done"] }, { ...ref(3), conditions: [] }] },
        { ...ref(2), dependsOn: [] },
        { ...parent, dependsOn: [] },
      ],
    };
    const r = parsePlanInput(bad, parent);
    expect(r.ok).toBe(false);
    const messages = r.ok ? [] : r.errors.map((e) => e.message).join("\n");
    expect(messages).toContain("自分自身に依存");
    expect(messages).toContain("不正な条件");
    expect(messages).toContain("条件が必要");
    expect(messages).toContain("重複");
    expect(messages).toContain("親Issue");
  });

  it("循環依存の経路を示す", () => {
    const r = parsePlanInput(
      {
        ...input,
        children: [
          { ...ref(1), dependsOn: [{ ...ref(2), conditions: ["closed"] }] },
          { ...ref(2), dependsOn: [{ ...ref(1), conditions: ["closed"] }] },
        ],
      },
      parent,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors[0].message).toContain(`${R}#1 → ${R}#2 → ${R}#1`);
  });

  it("番号だけの参照は受け付けない", () => {
    const r = parsePlanInput({ ...input, children: [{ number: 5, dependsOn: [] }] }, parent);
    expect(r.ok).toBe(false);
  });
});

describe("diffPlans / validateReplan", () => {
  it("追加・削除・変更を分け、完了済みの子は外せず、稼働中の削除は明示を求める", () => {
    const prev = plan();
    const next: PlanSnapshot = {
      ...prev,
      children: [...prev.children.filter((c) => c.number !== 1), { ...ref(9), dependsOn: [] }],
    };
    const d = diffPlans(prev, next);
    expect(d.added).toEqual([`${R}#9`]);
    expect(d.removed).toContain(`${R}#1`);
    const done = validateReplan(prev, next, { completed: new Set([`${R}#1`]), confirmRemove: new Set() });
    expect(done.map((i) => i.message).join()).toContain("完了済み");
    const open = validateReplan(prev, next, { completed: new Set(), confirmRemove: new Set() });
    expect(open.map((i) => i.message).join()).toContain("confirmRemove");
    const ok = validateReplan(prev, next, { completed: new Set(), confirmRemove: new Set([`${R}#1`]) });
    expect(ok).toEqual([]);
  });
});

describe("本文との不一致", () => {
  it("生成した本文は一致し、版・子の食い違いを検出する", () => {
    const p = plan();
    const body = renderPlanBody(p, 2);
    expect(detectBodyMismatch(body, p, 2)).toEqual([]);
    expect(detectBodyMismatch(body, p, 3)[0].kind).toBe("version");
    expect(detectBodyMismatch(body.replace(`${R}#4`, `${R}#5`), p, 2)[0].kind).toBe("children");
    expect(detectBodyMismatch("本文のみ", p, 2)[0].kind).toBe("missing");
  });
});

describe("verifyPlanAgainstGithub", () => {
  const deps = (over: Partial<VerifyDeps> = {}): VerifyDeps => ({
    tokenFor: async () => "t",
    issueState: async () => "open",
    branchPrs: async () => ({ kind: "none" }),
    subIssues: async () => [],
    ...over,
  });

  it("未着手の子へのmergedは登録できる。サブIssue未登録は警告", async () => {
    const r = await verifyPlanAgainstGithub(parent, plan(), deps());
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toContain("未登録");
  });

  it("存在しない・権限外・取得失敗・曖昧なPRは登録不可で、成功扱いしない", async () => {
    const missing = await verifyPlanAgainstGithub(parent, plan(), deps({ issueState: async (r) => (r.number === 2 ? null : "open") }));
    expect(missing.errors.map((e) => e.message).join()).toContain("存在しません");
    const noAccess = await verifyPlanAgainstGithub(parent, plan(), deps({ tokenFor: async (r) => (r === "guchi-apps/vps" ? null : "t") }));
    expect(noAccess.errors.map((e) => e.message).join()).toContain("権限外");
    const failed = await verifyPlanAgainstGithub(parent, plan(), deps({ issueState: async () => { throw new Error("HTTP 502"); } }));
    expect(failed.errors.map((e) => e.message).join()).toContain("取得に失敗");
    const many = await verifyPlanAgainstGithub(parent, plan(), deps({ branchPrs: async () => ({ kind: "many", numbers: [7, 8] }) }));
    expect(many.errors.map((e) => e.message).join()).toContain("複数");
  });

  it("クローズ済みでPRの無い依存先へのmergedは拒む", async () => {
    const r = await verifyPlanAgainstGithub(parent, plan(), deps({ issueState: async (x) => (x.number === 1 ? "closed" : "open") }));
    expect(r.errors.map((e) => e.message).join()).toContain("成立しません");
    expect(r.closed.has(`${R}#1`)).toBe(true);
  });
});
