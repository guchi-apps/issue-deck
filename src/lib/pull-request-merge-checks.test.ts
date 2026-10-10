import { describe, expect, it } from "vitest";

import { buildMergeChecks, type MergeChecksInput } from "@/lib/pull-request-merge-checks";
import type { ReleaseChangePullRequest } from "@/types/pull-request";

const shared: Omit<MergeChecksInput, "pullRequest"> = {
  overall: { mark: "▲", state: "要確認", tone: "warn", reason: "指摘 1件" },
  conflict: { mark: "●", state: "なし", tone: "ok", reason: null },
  releaseCi: "success",
  releaseHeadRef: "release-main/v1.0.0",
};

const pr = (overrides: Partial<ReleaseChangePullRequest> = {}): ReleaseChangePullRequest => ({
  number: 10,
  title: "t",
  issueNumber: 5,
  isVersionBump: false,
  review: {
    reviewKind: "ok",
    reviewLabel: "問題なし",
    riskKind: "none",
    riskLabel: "",
    riskReasons: [],
    confirmLabel: null,
    reviewedSha: "aaa",
  } as never,
  prHeadSha: "aaa",
  reviewUnavailable: false,
  mergeChecks: { ci: { state: "success" }, plan: { state: "reviewed", reason: null } },
  ...overrides,
});

const build = (pullRequest: ReleaseChangePullRequest | null) => buildMergeChecks({ ...shared, pullRequest });
const state = (items: ReturnType<typeof build>, key: string) => items.find((i) => i.key === key)!;

describe("buildMergeChecks", () => {
  it("5項目を固定の順序で返し、全体と競合だけが共通", () => {
    const items = build(pr());
    expect(items.map((i) => i.key)).toEqual(["ci", "plan", "code", "all", "conflict"]);
    expect(items.filter((i) => i.common).map((i) => i.key)).toEqual(["all", "conflict"]);
  });

  it("全行で全体レビューは同じ値を使う", () => {
    expect(state(build(pr()), "all").state).toBe(state(build(pr({ number: 11 })), "all").state);
  });

  it("成功と要修正が混在しても項目ごとの状態を保つ", () => {
    const items = build(
      pr({
        review: { reviewKind: "changes-requested", reviewLabel: "要修正", reviewedSha: "aaa" } as never,
        mergeChecks: { ci: { state: "failure" }, plan: { state: "findings", reason: "未応答の指摘: X" } },
      }),
    );
    expect(state(items, "ci").tone).toBe("bad");
    expect(state(items, "plan").state).toBe("要修正");
    expect(state(items, "code").state).toBe("要修正");
    expect(state(items, "conflict").tone).toBe("ok");
  });

  it("追加取得が無い・失敗は取得不可で、成功と推測しない", () => {
    const items = build(pr({ mergeChecks: undefined }));
    expect(state(items, "ci").state).toBe("取得不可");
    expect(state(items, "plan").state).toBe("取得不可");
    expect(state(items, "ci").tone).toBe("warn");
  });

  it("計画の記録なし・対象Issueなしは理由付きの対象外", () => {
    const noPlan = build(pr({ mergeChecks: { ci: { state: "success" }, plan: { state: "no-plan", reason: null } } }));
    expect(state(noPlan, "plan")).toMatchObject({ state: "対象外", tone: "muted" });
    const noIssue = build(
      pr({
        issueNumber: null,
        mergeChecks: { ci: { state: "success" }, plan: { state: "not-applicable", reason: "対応するIssueを特定できません" } },
      }),
    );
    expect(state(noIssue, "plan").reason).toContain("特定できません");
    expect(state(noIssue, "plan").evidence).toBeNull();
  });

  it("コードレビューの省略・記録なし・取得不可・古い結果を区別する", () => {
    const code = (p: ReleaseChangePullRequest | null) => state(build(p), "code");
    expect(code(pr({ review: { reviewKind: "skipped", reviewLabel: "", reviewedSha: "aaa" } as never })).state).toBe("省略");
    expect(code(pr({ review: null })).state).toBe("記録なし");
    expect(code(pr({ reviewUnavailable: true })).state).toBe("取得不可");
    expect(code(null).state).toBe("取得不可");
    expect(code(pr({ prHeadSha: "bbb" }))).toMatchObject({ state: "無効", tone: "warn" });
  });

  it("CIは個別PRの結果で、リリース候補のCIと混ぜない", () => {
    const ci = state(build(pr({ mergeChecks: { ci: { state: "none" }, plan: { state: "reviewed", reason: null } } })), "ci");
    expect(ci.state).toBe("記録なし");
    expect(ci.target).toContain("個別PR");
    expect(ci.reason).toContain("リリース候補");
  });
});
