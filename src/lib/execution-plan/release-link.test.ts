import { describe, expect, it } from "vitest";

import { evaluateReleasePrerequisites, findReleaseCycles, judgePreReleaseChild, type PlanForRelease } from "@/lib/execution-plan/release-link";
import type { PlanChild, PlanSnapshot } from "@/lib/execution-plan/types";
import { parsePlanInput } from "@/lib/execution-plan/validate";
import { evaluateRun, type RefObservation } from "@/lib/parent-run/decide";
import { evaluateReleaseMergeGate } from "@/lib/release-merge-gate";

const R = "guchi-apps/issue-deck";
const V = "guchi-apps/vps";
const key = (repo: string, n: number) => `${repo}#${n}`;
const obs = (o: Partial<RefObservation> = {}): RefObservation => ({
  issue: "open",
  pr: { kind: "none" },
  needsUser: false,
  jobStatus: null,
  sessionAlive: false,
  ...o,
});
const mergedPr = (n: number): RefObservation["pr"] => ({ kind: "one", number: n, merged: true, inProduction: false, integration: true });
const now = new Date();

const feature: PlanChild = { repository: R, number: 10, dependsOn: [] };
const envSetup: PlanChild = { repository: V, number: 20, timing: "pre-release", dependsOn: [] };
const prodCheck: PlanChild = { repository: R, number: 30, timing: "post-release", dependsOn: [{ repository: R, number: 10, conditions: ["released"] }] };
const unrelated: PlanChild = { repository: R, number: 40, timing: "independent", dependsOn: [] };
const plan: PlanSnapshot = { objective: "o", completionCriteria: ["c"], children: [feature, envSetup, prodCheck, unrelated] };

function entry(verified: Record<string, Date | null> = {}): PlanForRelease {
  return { parent: { repository: R, number: 1 }, plan, verifiedAt: new Map(Object.entries(verified)) };
}
function observations(extra: Record<string, RefObservation> = {}) {
  return new Map<string, RefObservation>([
    [key(R, 10), obs({ pr: mergedPr(100) })],
    [key(V, 20), obs()],
    [key(R, 30), obs()],
    [key(R, 40), obs()],
    ...Object.entries(extra),
  ]);
}
const evaluate = (verified: Record<string, Date | null>, extra: Record<string, RefObservation> = {}, prs = [100]) =>
  evaluateReleasePrerequisites({ candidateRepository: R, candidatePrNumbers: prs, plans: [entry(verified)], observations: observations(extra) });

describe("judgePreReleaseChild", () => {
  it("PRなしの作業はクローズだけでは成立しない", () => {
    const j = judgePreReleaseChild(envSetup, obs({ issue: "closed" }), null);
    expect(j.state).toBe("pending");
    expect(j.reason).toContain("検証結果が記録されていません");
  });
  it("クローズ＋検証結果の記録で成立する", () => {
    expect(judgePreReleaseChild(envSetup, obs({ issue: "closed" }), now).state).toBe("satisfied");
  });
  it("再オープンされた作業の古い検証結果は成功と扱わない", () => {
    expect(judgePreReleaseChild(envSetup, obs({ issue: "open" }), now).state).toBe("pending");
  });
  it("取得失敗・PR複数は成立ではなくunknown", () => {
    expect(judgePreReleaseChild(envSetup, obs({ issue: "error", error: "x" }), now).state).toBe("unknown");
    expect(judgePreReleaseChild(envSetup, obs({ pr: { kind: "many", numbers: [1, 2] } }), now).state).toBe("unknown");
  });
  it("PRを持つ作業はdevelopマージで成立し、mainへのマージは成立としない", () => {
    expect(judgePreReleaseChild(envSetup, obs({ pr: mergedPr(5) }), null).state).toBe("satisfied");
    expect(judgePreReleaseChild(envSetup, obs({ pr: { kind: "one", number: 5, merged: true, inProduction: true, integration: false } }), null).state).toBe("pending");
    expect(judgePreReleaseChild(envSetup, obs({ pr: { kind: "one", number: 5, merged: true, inProduction: null } }), null).state).toBe("unknown");
  });
});

describe("evaluateReleasePrerequisites", () => {
  it("前提設定が未完了なら候補を止め、理由・依存先・次の実行を返す", () => {
    const [b] = evaluate({});
    expect(b).toMatchObject({ ref: key(V, 20), state: "pending", gate: "merge", parent: key(R, 1) });
    expect(b.next).not.toBe("");
  });
  it("別リポジトリの前提も追う（候補のリポジトリに現れないことを無関係の根拠にしない）", () => {
    expect(evaluate({}).some((b) => b.ref.startsWith(V))).toBe(true);
  });
  it("Issueクローズだけでは解除されず、検証結果の記録後に解除される", () => {
    expect(evaluate({}, { [key(V, 20)]: obs({ issue: "closed" }) })).toHaveLength(1);
    expect(evaluate({ [key(V, 20)]: now }, { [key(V, 20)]: obs({ issue: "closed" }) })).toHaveLength(0);
  });
  it("リリース後・無関係の作業は候補を止めない", () => {
    expect(evaluate({ [key(V, 20)]: now }, { [key(V, 20)]: obs({ issue: "closed" }) })).toEqual([]);
  });
  it("候補に機能が含まれない計画は関門に混ぜない", () => {
    expect(evaluate({}, {}, [999])).toEqual([]);
  });
  it("観測できていない前提は成功と扱わない", () => {
    const o = observations();
    o.delete(key(V, 20));
    const [b] = evaluateReleasePrerequisites({ candidateRepository: R, candidatePrNumbers: [100], plans: [entry()], observations: o });
    expect(b.state).toBe("unknown");
  });
});

describe("findReleaseCycles / 計画の検証", () => {
  const cyclic: PlanChild[] = [
    { repository: R, number: 10, dependsOn: [] },
    { repository: V, number: 20, timing: "pre-release", dependsOn: [{ repository: R, number: 10, conditions: ["released"] }] },
  ];
  it("リリース前必須の作業が本番反映を待つ循環を、経路と直すべき依存つきで返す", () => {
    const [c] = findReleaseCycles(cyclic);
    expect(c.path).toEqual([key(V, 20), key(R, 10), "リリース", key(V, 20)]);
    expect(c.fix).toContain("merged");
  });
  it("pre-releaseが依存する子の先の本番待ちも検出する", () => {
    const chain: PlanChild[] = [
      { repository: R, number: 10, dependsOn: [] },
      { repository: R, number: 11, dependsOn: [{ repository: R, number: 10, conditions: ["verified"] }] },
      { repository: V, number: 20, timing: "pre-release", dependsOn: [{ repository: R, number: 11, conditions: ["merged"] }] },
    ];
    expect(findReleaseCycles(chain)).toHaveLength(1);
  });
  it("リリースと無関係な子を待つ場合・mergedを待つ場合は循環にしない", () => {
    expect(findReleaseCycles([{ ...cyclic[0], timing: "independent" }, cyclic[1]])).toEqual([]);
    expect(findReleaseCycles([cyclic[0], { ...cyclic[1], dependsOn: [{ repository: R, number: 10, conditions: ["merged"] }] }])).toEqual([]);
  });
  it("登録時に循環を拒否し、gateはpre-releaseだけに許す", () => {
    const parent = { repository: R, number: 1 };
    const body = (children: unknown[]) => ({ objective: "o", completionCriteria: ["c"], children });
    const bad = parsePlanInput(body(cyclic), parent);
    expect(bad.ok).toBe(false);
    const gateOnly = parsePlanInput(body([{ repository: R, number: 10, gate: "merge", dependsOn: [] }]), parent);
    expect(gateOnly.ok).toBe(false);
    const ok = parsePlanInput(body([{ repository: R, number: 10, timing: "pre-release", gate: "deploy", dependsOn: [] }]), parent);
    expect(ok.ok && ok.plan.children[0]).toMatchObject({ timing: "pre-release", gate: "deploy" });
    expect(parsePlanInput(body([{ repository: R, number: 10, timing: "later", dependsOn: [] }]), parent).ok).toBe(false);
  });
});

describe("evaluateReleaseMergeGate（前提）", () => {
  const current = { baseSha: "b", headSha: "h" };
  it("検証の強制なしでも、前提が未完了ならblockedにする", () => {
    const prerequisites = evaluate({});
    const gate = evaluateReleaseMergeGate({ current, records: [], enforced: false, prerequisites });
    expect(gate.status).toBe("blocked");
    expect(gate.prerequisites).toHaveLength(1);
  });
  it("前提が無ければ従来どおり", () => {
    expect(evaluateReleaseMergeGate({ current, records: [], enforced: false }).status).toBe("not_enforced");
  });
});

describe("親の完了（機能全体）", () => {
  const children = plan.children.filter((c) => c.timing !== "independent");
  function complete(states: Record<number, RefObservation>, verified: number[], parentVerified: boolean) {
    const observationsMap = new Map<string, RefObservation>(
      plan.children.map((c) => [key(c.repository, c.number), states[c.number] ?? obs({ issue: "closed" })]),
    );
    return evaluateRun({
      plan: { ...plan, children },
      status: "RUNNING",
      maxParallel: 2,
      children: children.map((child) => ({
        child,
        launchState: "LAUNCHED" as const,
        verifiedAt: verified.includes(child.number) ? now : null,
        lastError: null,
      })),
      observations: observationsMap,
      parentVerifiedAt: parentVerified ? now : null,
    });
  }
  const released = obs({ issue: "closed", pr: { kind: "one", number: 100, merged: true, inProduction: true, integration: true } });
  it("マージ・リリース済みでも、本番確認の作業と親の確認が残れば未完了", () => {
    const r = complete({ 10: released }, [], false);
    expect(r.completion.complete).toBe(false);
    expect(r.completion.evidence.find((e) => e.label === "リリース前後の作業の検証")?.ok).toBe(false);
  });
  it("作業の検証と親の本番確認が揃えば完了へ遷移する", () => {
    expect(complete({ 10: released }, [20, 30], true).completion.complete).toBe(true);
  });
});
