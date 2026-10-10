import { describe, expect, it } from "vitest";

import { parseSessionInstruction } from "@/lib/dispatch/dispatch-job";
import {
  buildDependencyResumeInstruction,
  decideDependencyWait,
  describeDependencyWait,
  detectLegacyHoldCandidate,
  evaluateConditions,
  parseDependencyWaitInput,
  type DependencyObservation,
  type DependencyRef,
  type DependencyWaitView,
} from "@/lib/dispatch/dependency-wait";

const pr: DependencyRef = { repository: "guchi-apps/aide", number: 615, kind: "pr" };
const issue: DependencyRef = { repository: "guchi-apps/aide", number: 614, kind: "issue" };

const observed = (o: Partial<DependencyObservation>): DependencyObservation => ({
  state: "open",
  merged: null,
  baseRef: null,
  inProduction: null,
  ...o,
});

describe("parseDependencyWaitInput", () => {
  const ok = {
    dependency: { repository: "guchi-apps/aide", number: 614, kind: "issue" },
    conditions: ["closed", "closed", "released"],
    reason: "  aide#614の完了待ち \n",
  };
  it("正しい入力を正規化する", () => {
    expect(parseDependencyWaitInput(ok)).toEqual({
      dependency: ok.dependency,
      conditions: ["closed", "released"],
      reason: "aide#614の完了待ち",
    });
  });
  it.each([
    ["依存先が無い", { ...ok, dependency: null }],
    ["リポジトリ名が不正", { ...ok, dependency: { ...ok.dependency, repository: "a b/c" } }],
    ["条件が空", { ...ok, conditions: [] }],
    ["未知の条件", { ...ok, conditions: ["done"] }],
    ["理由が空", { ...ok, reason: "  " }],
  ])("拒む: %s", (_, payload) => {
    expect(parseDependencyWaitInput(payload)).toBeNull();
  });
});

describe("evaluateConditions と decideDependencyWait", () => {
  it("Issueがクローズされただけでは、本番反映・検証までは済んだとみなさない", () => {
    const results = evaluateConditions(["closed", "released", "verified"], issue, observed({ state: "closed" }));
    expect(results.map((r) => r.satisfied)).toEqual([true, null, null]);
    expect(decideDependencyWait(results)).toBe("needs_confirm");
  });

  it("developへマージ済みでもmain未反映なら待つ", () => {
    const results = evaluateConditions(
      ["merged", "released"],
      pr,
      observed({ state: "closed", merged: true, baseRef: "develop", inProduction: false }),
    );
    expect(results.map((r) => r.satisfied)).toEqual([true, false]);
    expect(decideDependencyWait(results)).toBe("wait");
  });

  it("mainまで入っていれば再開する", () => {
    const results = evaluateConditions(
      ["released"],
      pr,
      observed({ state: "closed", merged: true, baseRef: "develop", inProduction: true }),
    );
    expect(decideDependencyWait(results)).toBe("resume");
  });

  it("人の検証が要る条件は自動では成立しない", () => {
    const results = evaluateConditions(["verified"], pr, observed({ state: "closed", merged: true }));
    expect(decideDependencyWait(results)).toBe("needs_confirm");
  });

  it("未成立が1つでもあれば、判断不能が残っていても待つ", () => {
    const results = evaluateConditions(["closed", "verified"], issue, observed({ state: "open" }));
    expect(decideDependencyWait(results)).toBe("wait");
  });

  it("mainへの反映を確認できなければ成立とみなさない", () => {
    const results = evaluateConditions(["released"], pr, observed({ merged: true, inProduction: null }));
    expect(decideDependencyWait(results)).toBe("needs_confirm");
  });
});

describe("buildDependencyResumeInstruction", () => {
  it("追加指示として受け付けられる1行になる", () => {
    expect(parseSessionInstruction(buildDependencyResumeInstruction(pr))).not.toBeNull();
  });
});

describe("describeDependencyWait", () => {
  const base: DependencyWaitView = {
    id: "w1",
    repositoryFullName: "guchi-apps/asset-manager",
    issueNumber: 687,
    dependency: issue,
    dependencyUrl: "https://github.com/guchi-apps/aide/issues/614",
    conditions: ["closed", "released"],
    reason: "aide#614待ち",
    status: "WAITING",
    source: "session",
    results: evaluateConditions(["closed", "released"], issue, observed({ state: "closed" })),
    lastCheckedAt: null,
    lastError: null,
    failureReason: null,
    resumeRequestedAt: null,
    resumeSentAt: null,
    resumedAt: null,
  };
  it("待機中は操作不要で、残る条件を示す", () => {
    const notice = describeDependencyWait(base);
    expect(notice.shortLabel).toBe("依存待ち");
    expect(notice.tone).toBe("pending");
    expect(notice.nextStep).toContain("操作は不要");
    expect(notice.nextStep).toContain("本番（main）");
  });
  it("再開の要求・送信済み・失敗を区別する", () => {
    const labels = (["RESUME_REQUESTED", "RESUME_SENT", "RESUMED", "RESUME_FAILED"] as const).map(
      (status) => describeDependencyWait({ ...base, status, failureReason: "セッションが終了しています" }).label,
    );
    expect(new Set(labels).size).toBe(4);
  });
});

describe("detectLegacyHoldCandidate", () => {
  it("保留コメントから依存先の候補を拾う", () => {
    const candidate = detectLegacyHoldCandidate([
      "着手します",
      "保留します。guchi-apps/aide#614 の完了を待ちます。コード変更なし。",
    ]);
    expect(candidate?.dependency).toEqual({ repository: "guchi-apps/aide", number: 614, kind: "issue" });
  });
  it("URLがPRなら種別をprにする", () => {
    const candidate = detectLegacyHoldCandidate(["待機: https://github.com/guchi-apps/aide/pull/615"]);
    expect(candidate?.dependency.kind).toBe("pr");
  });
  it("保留の語が無ければ拾わない", () => {
    expect(detectLegacyHoldCandidate(["guchi-apps/aide#614 を参照した"])).toBeNull();
  });
});
