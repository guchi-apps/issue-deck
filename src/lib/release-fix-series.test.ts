import { describe, expect, it } from "vitest";

import {
  buildReleaseFixIssue,
  buildReleaseFixSourceKey,
  canStartNextGeneration,
  classifyIntegrationFailure,
  decideReleaseFix,
  decideReverification,
  releaseFixStepIndex,
  RELEASE_FIX_MAX_GENERATION,
  type ReleaseFixSeriesSnapshot,
} from "@/lib/release-fix-series";

const snapshot = (over: Partial<ReleaseFixSeriesSnapshot> = {}): ReleaseFixSeriesSnapshot => ({
  id: "s1",
  status: "fix_in_progress",
  issueNumber: 10,
  fixPrNumber: 100,
  fixPrMerged: true,
  fixPrClosedUnmerged: false,
  acceptedExtraPrs: [],
  ...over,
});
const open = { originStillOpen: true, originMerged: false, developPullRequests: [] as number[] };

describe("buildReleaseFixSourceKey", () => {
  const base = {
    repositoryFullName: "o/r",
    releasePrNumber: 5,
    baseSha: "a",
    headSha: "b",
    sourceKind: "review_finding" as const,
  };
  it("指摘の並び順や重複に依らず同じ鍵になる", () => {
    expect(buildReleaseFixSourceKey({ ...base, itemKeys: ["x", "y"] })).toBe(
      buildReleaseFixSourceKey({ ...base, itemKeys: ["y", "x", "x"] }),
    );
  });
  it("SHAが変われば別の鍵になる（旧SHAの起案を新しい対象へ流用しない）", () => {
    expect(buildReleaseFixSourceKey({ ...base, itemKeys: ["x"] })).not.toBe(
      buildReleaseFixSourceKey({ ...base, headSha: "c", itemKeys: ["x"] }),
    );
  });
});

describe("classifyIntegrationFailure", () => {
  it("終了コード126や接続失敗は実行障害", () => {
    expect(classifyIntegrationFailure("command exited with code 126")).toBe("execution");
    expect(classifyIntegrationFailure("connect ECONNREFUSED 127.0.0.1")).toBe("execution");
  });
  it("テスト・ビルドの失敗はコードの不具合", () => {
    expect(classifyIntegrationFailure("pnpm test: 3 tests failed")).toBe("code");
  });
  it("判断が付かないものはunknown（コード修正を強制しない）", () => {
    expect(classifyIntegrationFailure("")).toBe("unknown");
    expect(classifyIntegrationFailure("something odd")).toBe("unknown");
  });
});

describe("decideReleaseFix", () => {
  it("修正PRが揃うまで待つ", () => {
    expect(
      decideReleaseFix({ series: [snapshot(), snapshot({ id: "s2", fixPrMerged: false })], candidate: open }),
    ).toEqual({ action: "wait" });
  });
  it("全部マージ済みで無関係な変更が無ければ作り直す", () => {
    const decision = decideReleaseFix({
      series: [snapshot(), snapshot({ id: "s2", fixPrNumber: 101 })],
      candidate: { ...open, developPullRequests: [100, 101] },
    });
    expect(decision).toEqual({ action: "rebuild", seriesIds: ["s1", "s2"], selectedPrs: [] });
  });
  it("選んだ作り直しに対応していれば、無関係な変更があっても修正PRだけを選んで作り直す（#4335）", () => {
    const decision = decideReleaseFix({
      series: [snapshot()],
      candidate: { ...open, developPullRequests: [100, 200] },
      selective: true,
    });
    expect(decision).toEqual({ action: "rebuild", seriesIds: ["s1"], selectedPrs: [100] });
  });
  it("選んだ作り直しでは、確認済みのPRも足すが、developに入っていないものは選ばない", () => {
    const decision = decideReleaseFix({
      series: [snapshot({ acceptedExtraPrs: [200, 300] })],
      candidate: { ...open, developPullRequests: [100, 200] },
      selective: true,
    });
    expect(decision).toEqual({ action: "rebuild", seriesIds: ["s1"], selectedPrs: [100, 200] });
  });
  it("選んだ作り直しで足す修正PRが無ければ止める", () => {
    const decision = decideReleaseFix({
      series: [snapshot()],
      candidate: { ...open, developPullRequests: [200] },
      selective: true,
    });
    expect(decision).toMatchObject({ action: "stop", status: "stopped" });
  });
  it("無関係な変更が入っていたら作り直さず判断待ちにする", () => {
    const decision = decideReleaseFix({
      series: [snapshot()],
      candidate: { ...open, developPullRequests: [100, 200] },
    });
    expect(decision).toMatchObject({ action: "stop", status: "awaiting_decision" });
    expect(decision.action === "stop" && decision.reason).toContain("#200");
  });
  it("確認済みの無関係な変更は含めて作り直す", () => {
    const decision = decideReleaseFix({
      series: [snapshot({ acceptedExtraPrs: [200] })],
      candidate: { ...open, developPullRequests: [100, 200] },
    });
    expect(decision.action).toBe("rebuild");
  });
  it("元候補が取消・置換されていたら誤った候補へ取り込まず対象外にする", () => {
    expect(
      decideReleaseFix({ series: [snapshot()], candidate: { ...open, originStillOpen: false } }),
    ).toMatchObject({ action: "stop", status: "superseded" });
    expect(
      decideReleaseFix({ series: [snapshot()], candidate: { ...open, originStillOpen: false, originMerged: true } }),
    ).toMatchObject({ action: "stop", status: "superseded" });
  });
  it("修正PRがマージされずに閉じたら理由付きで止める", () => {
    expect(
      decideReleaseFix({ series: [snapshot({ fixPrMerged: false, fixPrClosedUnmerged: true })], candidate: open }),
    ).toMatchObject({ action: "stop", status: "stopped" });
  });
  it("作り直し済みの系列は対象にしない（二重の作り直しを起こさない）", () => {
    expect(decideReleaseFix({ series: [snapshot({ status: "rebuilding" })], candidate: open })).toEqual({
      action: "wait",
    });
  });
});

describe("decideReverification", () => {
  it("両方成功のときだけ準備完了", () => {
    expect(decideReverification({ integration: "passed", aiReview: "passed" })).toBe("ready");
    expect(decideReverification({ integration: "passed", aiReview: "not_applicable" })).toBe("ready");
  });
  it("どちらかが未完了なら待つ", () => {
    expect(decideReverification({ integration: "passed", aiReview: "pending" })).toBe("pending");
  });
  it("失敗・要確認は修正へ戻す", () => {
    expect(decideReverification({ integration: "failed", aiReview: "passed" })).toBe("needs_fix");
    expect(decideReverification({ integration: "passed", aiReview: "needs_check" })).toBe("needs_fix");
  });
});

describe("canStartNextGeneration", () => {
  it("上限を超えたら止める", () => {
    expect(
      canStartNextGeneration({ generation: RELEASE_FIX_MAX_GENERATION + 1, sourceKey: "k", ancestorSourceKeys: [] }),
    ).toMatchObject({ ok: false });
  });
  it("同一の指摘が再発したら止める", () => {
    expect(canStartNextGeneration({ generation: 2, sourceKey: "k", ancestorSourceKeys: ["k"] })).toMatchObject({
      ok: false,
    });
    expect(canStartNextGeneration({ generation: 2, sourceKey: "k2", ancestorSourceKeys: ["k"] })).toEqual({ ok: true });
  });
});

describe("releaseFixStepIndex", () => {
  it("状態ごとの現在地", () => {
    expect(releaseFixStepIndex({ status: "issue_created", fixPrNumber: null, successorPrNumber: null })).toBe(1);
    expect(releaseFixStepIndex({ status: "fix_in_progress", fixPrNumber: 3, successorPrNumber: null })).toBe(2);
    expect(releaseFixStepIndex({ status: "ready", fixPrNumber: 3, successorPrNumber: 9 })).toBe(6);
    expect(releaseFixStepIndex({ status: "stopped", fixPrNumber: 3, successorPrNumber: 9 })).toBe(5);
  });
});

describe("buildReleaseFixIssue", () => {
  it("機密を除いた根拠・SHA・元PR・検証条件を引き継ぎ、目印を先頭に置く", () => {
    const { title, body } = buildReleaseFixIssue(
      {
        repositoryFullName: "o/r",
        releasePrNumber: 5,
        releaseVersion: "1.2.3",
        baseSha: "aaaa",
        headSha: "bbbb",
        sourceKind: "review_finding",
        causeClass: "decision",
        items: [{ title: "T", detail: "d", file: "a.ts:3", evidence: "e", recommendation: "r", pullRequests: [7] }],
        decisionQuestion: "AかBか",
        previousIssueNumber: 9,
        generation: 2,
        relatedPullRequests: [7],
        verifyConditions: ["条件1"],
      },
      "key123",
    );
    expect(title).toContain("#5");
    expect(body.startsWith("<!-- issue-deck-release-fix:key123 -->")).toBe(true);
    for (const text of ["aaaa", "bbbb", "v1.2.3", "AかB", "#9", "#7", "条件1", "a.ts:3"]) {
      expect(body).toContain(text);
    }
  });
});
