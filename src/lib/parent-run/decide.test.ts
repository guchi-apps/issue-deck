import { describe, expect, it } from "vitest";

import type { PlanSnapshot } from "@/lib/execution-plan/types";
import {
  evaluateDependency,
  evaluateRun,
  type ChildInput,
  type PrResolution,
  type RefObservation,
  type RunEvaluationInput,
} from "@/lib/parent-run/decide";

const R = "guchi-apps/issue-deck";
const ref = (n: number) => ({ repository: R, number: n });
const key = (n: number) => `${R}#${n}`;

// A(1) → B(2)・C(3) 並行 → D(4)
const plan: PlanSnapshot = {
  objective: "o",
  completionCriteria: ["c"],
  children: [
    { ...ref(1), dependsOn: [] },
    { ...ref(2), dependsOn: [{ ...ref(1), conditions: ["merged"] }] },
    { ...ref(3), dependsOn: [{ ...ref(1), conditions: ["merged"] }] },
    { ...ref(4), dependsOn: [{ ...ref(2), conditions: ["verified"] }, { ...ref(3), conditions: ["verified"] }] },
  ],
};

const obs = (o: Partial<RefObservation> = {}): RefObservation => ({
  issue: "open",
  pr: { kind: "none" },
  needsUser: false,
  jobStatus: null,
  sessionAlive: false,
  ...o,
});
const merged = (n: number, inProduction: boolean | null = false): PrResolution => ({ kind: "one", number: n, merged: true, inProduction });
const open = (n: number): PrResolution => ({ kind: "one", number: n, merged: false, inProduction: null });

function run(
  states: Record<number, Partial<RefObservation>>,
  launch: Record<number, ChildInput["launchState"]> = {},
  extra: Partial<RunEvaluationInput> = {},
  verified: number[] = [],
) {
  const observations = new Map<string, RefObservation>();
  for (const c of plan.children) observations.set(key(c.number), obs(states[c.number] ?? {}));
  return evaluateRun({
    plan,
    status: "RUNNING",
    maxParallel: 2,
    children: plan.children.map((child) => ({
      child,
      launchState: launch[child.number] ?? "PENDING",
      verifiedAt: verified.includes(child.number) ? new Date() : null,
      lastError: null,
    })),
    observations,
    parentVerifiedAt: null,
    ...extra,
  });
}

const phase = (r: ReturnType<typeof run>, n: number) => r.children.find((c) => c.child.number === n)?.display.phase;

describe("evaluateRun", () => {
  it("開始直後は前提のないAだけ起動する", () => {
    const r = run({});
    expect(r.toLaunch).toEqual([key(1)]);
    expect(phase(r, 2)).toBe("waiting");
  });

  it("Aがクローズだけでは次へ進まず、developへのマージで B・C を並行起動する", () => {
    // Aは実装PRなしでクローズ → mergedは人の確認（自動では進めない）
    const closedOnly = run({ 1: { issue: "closed" } }, { 1: "LAUNCHED" });
    expect(closedOnly.toLaunch).toEqual([]);
    expect(phase(closedOnly, 2)).toBe("attention");

    const prOnly = run({ 1: { pr: open(10), sessionAlive: true } }, { 1: "LAUNCHED" });
    expect(prOnly.toLaunch).toEqual([]);
    expect(phase(prOnly, 1)).toBe("running");

    const ok = run({ 1: { pr: merged(10) } }, { 1: "LAUNCHED" });
    expect(ok.toLaunch).toEqual([key(2), key(3)]);
    expect(phase(ok, 4)).toBe("waiting");
  });

  it("同時起動数の上限を、起動済みの子を含めて守る", () => {
    const r = run({ 1: { pr: merged(10) }, 2: { sessionAlive: true } }, { 1: "LAUNCHED", 2: "LAUNCHED" }, { maxParallel: 2 });
    expect(r.toLaunch).toEqual([key(3)]);
    const full = run({ 1: { pr: merged(10) }, 2: { sessionAlive: true }, 3: { sessionAlive: true } }, { 1: "LAUNCHED", 2: "LAUNCHED", 3: "LAUNCHED" });
    expect(full.toLaunch).toEqual([]);
  });

  it("B・Cの検証が記録されてはじめてDを起動する", () => {
    const states = { 1: { pr: merged(10) }, 2: { pr: merged(11, true) }, 3: { pr: merged(12, true) } };
    const launched = { 1: "LAUNCHED", 2: "LAUNCHED", 3: "LAUNCHED" } as const;
    const unverified = run(states, launched);
    expect(unverified.toLaunch).toEqual([]);
    expect(phase(unverified, 4)).toBe("attention");
    expect(unverified.children[3].display.action).toBe("verify");
    const verified = run(states, launched, {}, [2, 3]);
    expect(verified.toLaunch).toEqual([key(4)]);
  });

  it("本番確認の記録だけでは、実装PRのmain反映が無い子のverifiedを成立としない", () => {
    const states = { 1: { pr: merged(10) }, 2: { pr: merged(11, false) }, 3: { pr: merged(12, true) } };
    const launched = { 1: "LAUNCHED", 2: "LAUNCHED", 3: "LAUNCHED" } as const;
    const r = run(states, launched, {}, [2, 3]);
    expect(r.toLaunch).toEqual([]);
    expect(phase(r, 4)).toBe("waiting");
  });

  it("全子をPRなしでクローズしても、親の完了（develop・main反映）の証拠にしない", () => {
    const closed = { issue: "closed" as const };
    const r = run({ 1: closed, 2: closed, 3: closed, 4: closed }, {}, { parentVerifiedAt: new Date() });
    expect(r.completion.complete).toBe(false);
    expect(r.completion.evidence.filter((e) => !e.ok).map((e) => e.label)).toEqual(["子のdevelopマージ", "本番（main）への反映"]);
  });

  it("一時停止中は未起動の子を起動しない", () => {
    const r = run({}, {}, { status: "PAUSED" });
    expect(r.toLaunch).toEqual([]);
    expect(phase(r, 1)).toBe("ready");
  });

  it("失敗した子に依存する後続は止まり、独立した子は進む", () => {
    const r = run({ 1: { pr: merged(10) }, 2: { jobStatus: "FAILED" } }, { 1: "LAUNCHED", 2: "LAUNCHED" });
    expect(phase(r, 2)).toBe("attention");
    expect(r.children[1].display.action).toBe("retry");
    expect(phase(r, 4)).toBe("blocked");
    expect(r.toLaunch).toEqual([key(3)]);
  });

  it("本人操作待ちの子を示し、依存先の取得失敗は完了と扱わない", () => {
    const user = run({ 1: { sessionAlive: true, needsUser: true } }, { 1: "LAUNCHED" });
    expect(user.children[0].display.action).toBe("user");
    expect(phase(user, 2)).toBe("blocked");
    const failed = run({ 1: { pr: { kind: "error", message: "HTTP 502" } } }, { 1: "LAUNCHED", });
    expect(phase(failed, 2)).toBe("blocked");
    expect(failed.toLaunch).toEqual([]);
  });

  it("実行中・完了済みの子は起動対象に入れない（成果を再利用）", () => {
    const r = run({ 1: { issue: "closed", pr: merged(10, true) } }, {});
    expect(phase(r, 1)).toBe("done");
    expect(r.toLaunch).not.toContain(key(1));
    expect(r.toLaunch).toEqual([key(2), key(3)]);
  });

  it("子が全てマージ済みでも、本番反映と本番確認が残れば親は未完了", () => {
    const states = { 1: { pr: merged(1) }, 2: { pr: merged(2) }, 3: { pr: merged(3) }, 4: { pr: merged(4) } };
    const r = run(states, { 1: "LAUNCHED", 2: "LAUNCHED", 3: "LAUNCHED", 4: "LAUNCHED" }, {}, [2, 3]);
    expect(r.counts.done).toBe(4);
    expect(r.completion.complete).toBe(false);
    const prod = run(
      { 1: { pr: merged(1, true) }, 2: { pr: merged(2, true) }, 3: { pr: merged(3, true) }, 4: { pr: merged(4, true) } },
      { 1: "LAUNCHED", 2: "LAUNCHED", 3: "LAUNCHED", 4: "LAUNCHED" },
      { parentVerifiedAt: new Date() },
    );
    expect(prod.completion.complete).toBe(true);
  });

  it("起動の受付中・起動済みでセッションが無い子を実行扱いにして二重起動を防ぐ", () => {
    const r = run({}, { 1: "LAUNCHING" });
    expect(phase(r, 1)).toBe("launching");
    expect(r.toLaunch).toEqual([]);
  });

  it("Issueが見つからない子は要対応にして後続を止める", () => {
    const r = run({ 1: { issue: "missing" } });
    expect(phase(r, 1)).toBe("attention");
    expect(phase(r, 2)).toBe("blocked");
  });
});

describe("mergedは統合ブランチへのマージだけで成立する（#4570）", () => {
  const dep = { repository: "o/r", number: 1, conditions: ["merged" as const] };
  const obs = (integration?: boolean) =>
    ({
      issue: "open",
      pr: { kind: "one", number: 5, merged: true, inProduction: false, integration },
      needsUser: false,
      jobStatus: null,
      sessionAlive: false,
    }) as never;
  it("developへのマージ済みなら成立（Issueはopenのまま）", () => {
    expect(evaluateDependency(dep, obs(true), null)[0].satisfied).toBe(true);
  });
  it("mainなど別ブランチへのマージは成立しない", () => {
    expect(evaluateDependency(dep, obs(false), null)[0].satisfied).toBe(false);
  });
});
