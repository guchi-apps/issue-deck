import { describe, expect, it } from "vitest";

import {
  allocateSegmentWidths,
  canCreateFollowupFromComment,
  getWorkflowStepIndex,
  hasActiveWorkflowStep,
  resolveProgressSegments,
  WORKFLOW_STEPS,
} from "@/lib/github/workflow-status";

describe("WORKFLOW_STEPS", () => {
  it("未着手を除く6状態を遷移順に持つ", () => {
    expect(WORKFLOW_STEPS.map((step) => step.key)).toEqual([
      "planning",
      "implementation",
      "develop-pr",
      "develop",
      "release",
      "done",
    ]);
  });
});

describe("getWorkflowStepIndex", () => {
  it("Project Statusから現在ステップを引く", () => {
    expect(getWorkflowStepIndex({ projectStatus: "Planning" })).toBe(0);
    expect(getWorkflowStepIndex({ projectStatus: "Develop" })).toBe(3);
    expect(getWorkflowStepIndex({ projectStatus: "Done" })).toBe(5);
  });

  it("Statusが無い・未着手・未知の名前ならnull（ステップ表示自体を出さない）", () => {
    expect(getWorkflowStepIndex({ projectStatus: null })).toBeNull();
    expect(getWorkflowStepIndex({ projectStatus: "Ready" })).toBeNull();
    expect(getWorkflowStepIndex({ projectStatus: "Blocked" })).toBeNull();
  });
});

describe("hasActiveWorkflowStep", () => {
  it("実行が進行し得る段階ではtrueを返す", () => {
    expect(hasActiveWorkflowStep({ projectStatus: "Planning" })).toBe(true);
    expect(hasActiveWorkflowStep({ projectStatus: "Implementation" })).toBe(true);
    expect(hasActiveWorkflowStep({ projectStatus: "Develop PR" })).toBe(true);
    expect(hasActiveWorkflowStep({ projectStatus: "Release" })).toBe(true);
  });

  it("マージ完了後の定常状態ではfalseを返す（ポーリング対象から外す）", () => {
    expect(hasActiveWorkflowStep({ projectStatus: "Develop" })).toBe(false);
    expect(hasActiveWorkflowStep({ projectStatus: "Done" })).toBe(false);
  });

  it("進捗が始まっていない場合はfalseを返す", () => {
    expect(hasActiveWorkflowStep({ projectStatus: null })).toBe(false);
    expect(hasActiveWorkflowStep({ projectStatus: "Ready" })).toBe(false);
  });
});

describe("canCreateFollowupFromComment", () => {
  it("closedなissueではtrueを返す", () => {
    expect(canCreateFollowupFromComment({ state: "closed", projectStatus: null })).toBe(true);
    expect(canCreateFollowupFromComment({ state: "closed", projectStatus: "Implementation" })).toBe(
      true,
    );
  });

  it("openかつdevelopマージ未満の段階ではfalseを返す", () => {
    expect(canCreateFollowupFromComment({ state: "open", projectStatus: null })).toBe(false);
    expect(canCreateFollowupFromComment({ state: "open", projectStatus: "Planning" })).toBe(false);
    expect(canCreateFollowupFromComment({ state: "open", projectStatus: "Implementation" })).toBe(
      false,
    );
    expect(canCreateFollowupFromComment({ state: "open", projectStatus: "Develop PR" })).toBe(false);
  });

  it("openでもdevelopマージ以降の段階ではtrueを返す", () => {
    expect(canCreateFollowupFromComment({ state: "open", projectStatus: "Develop" })).toBe(true);
    expect(canCreateFollowupFromComment({ state: "open", projectStatus: "Release" })).toBe(true);
    expect(canCreateFollowupFromComment({ state: "open", projectStatus: "Done" })).toBe(true);
  });
});

describe("resolveProgressSegments（#2867・#2927）", () => {
  const states = (result: ReturnType<typeof resolveProgressSegments>) =>
    result?.segments.map((segment) => `${segment.key}:${segment.state}`);

  it("いまの段より前のマスは済み、後のマスはまだ。段に1マスならそれがいま", () => {
    const planning = resolveProgressSegments({ projectStatus: "Planning" });
    expect(states(planning)).toEqual([
      "planning:current",
      "exploring:pending",
      "editing:pending",
      "verifying:pending",
      "pr-checks:pending",
      "pr-merge:pending",
      "develop:pending",
    ]);
    expect(planning?.ratio).toBe(0);
    expect(planning?.productionTracker).toBe("hidden");
  });

  it("developへのマージが完了した時点で7マス全部済み・目安100%になる（#2927）", () => {
    const develop = resolveProgressSegments({ projectStatus: "Develop" });
    expect(develop?.segments.every((segment) => segment.state === "done")).toBe(true);
    expect(develop?.ratio).toBe(100);
    // develop到達済み・本番マージはまだなので2点トラッカーは両方輪郭
    expect(develop?.productionTracker).toBe("pending");
  });

  it("実装の中は位置で決める。位置が無ければ最初のマス（調査）", () => {
    expect(states(resolveProgressSegments({ projectStatus: "Implementation" }))?.slice(0, 4)).toEqual([
      "planning:done",
      "exploring:current",
      "editing:pending",
      "verifying:pending",
    ]);
    const verifying = resolveProgressSegments(
      { projectStatus: "Implementation" },
      { implementation: "verifying" },
    );
    expect(states(verifying)?.slice(0, 5)).toEqual([
      "planning:done",
      "exploring:done",
      "editing:done",
      "verifying:current",
      "pr-checks:pending",
    ]);
    // 済み3マス（計画・調査・実装）／7マス
    expect(verifying?.ratio).toBe(43);
    expect(verifying?.productionTracker).toBe("hidden");
  });

  it("developへマージの中はPRの位置で決める", () => {
    const merge = resolveProgressSegments({ projectStatus: "Develop PR" }, { developPr: "merge" });
    expect(states(merge)?.slice(4, 7)).toEqual(["pr-checks:done", "pr-merge:current", "develop:pending"]);
    // 実装の位置を渡していても、段が進んでいれば実装のマスは全部済み
    const checks = resolveProgressSegments(
      { projectStatus: "Develop PR" },
      { implementation: "exploring", developPr: "checks" },
    );
    expect(states(checks)?.slice(1, 5)).toEqual([
      "exploring:done",
      "editing:done",
      "verifying:done",
      "pr-checks:current",
    ]);
  });

  it("本番へマージ中（Release）は主バー全部済み・2点トラッカーの1つ目だけ点灯", () => {
    const release = resolveProgressSegments({ projectStatus: "Release" });
    expect(release?.segments.every((segment) => segment.state === "done")).toBe(true);
    expect(release?.ratio).toBe(100);
    expect(release?.productionTracker).toBe("in-progress");
  });

  it("本番反映済（Done）は主バー全部済み・2点トラッカーも両方点灯", () => {
    const done = resolveProgressSegments({ projectStatus: "Done" });
    expect(done?.segments.every((segment) => segment.state === "done")).toBe(true);
    expect(done?.ratio).toBe(100);
    expect(done?.productionTracker).toBe("done");
  });

  it("段の境目に印を付ける（4段のまとまりをすき間で示す）", () => {
    const result = resolveProgressSegments({ projectStatus: "Planning" });
    expect(result?.segments.map((segment) => segment.stageEnd)).toEqual([
      true, // 計画｜調査
      false,
      false,
      true, // 検証・仕上げ｜CI・レビュー
      false,
      true, // マージ待ち｜develop反映済
      false, // 末尾
    ]);
  });

  it("未着手・Statusなし・未知の名前ではnull（バー自体を出さない）", () => {
    expect(resolveProgressSegments({ projectStatus: "Ready" })).toBeNull();
    expect(resolveProgressSegments({ projectStatus: null })).toBeNull();
    expect(resolveProgressSegments({ projectStatus: "Blocked" })).toBeNull();
  });
});

describe("allocateSegmentWidths（#2867）", () => {
  it("重み比で整数pxに配り、合計は必ず使える幅に一致する", () => {
    const widths = allocateSegmentWidths([12, 16, 20, 14, 8, 4, 12, 10, 4], 27, 2);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(27);
    expect(widths.every((width) => width >= 2)).toBe(true);
    // 重みの順序が幅の順序として保たれる（同じ重みは同じ幅）
    expect(widths[2]).toBeGreaterThan(widths[0]);
    expect(widths[0]).toBe(widths[6]);
    expect(widths[5]).toBe(widths[8]);
  });

  it("下限で膨らんだぶんは大きいマスから削って幅を超えない", () => {
    // 0.42/0.42/0.42/13.6 → 下限で3/3/3/13＝22 → 大きいマスから8px削る
    const widths = allocateSegmentWidths([1, 1, 1, 97], 14, 3);
    expect(widths).toEqual([3, 3, 3, 5]);
    // 下限×マス数が幅を超えるときは下限を守る（合計は超える。呼び出し側の寸法の誤り）
    expect(allocateSegmentWidths([1, 1, 1, 97], 10, 3)).toEqual([3, 3, 3, 3]);
  });

  it("端数は切り捨てた余りの大きい順に1pxずつ足す", () => {
    // 10:5 で 8px → 5.33:2.67 → 5:2 に余り1を端数の大きい2番目へ
    expect(allocateSegmentWidths([10, 5], 8, 1)).toEqual([5, 3]);
    expect(allocateSegmentWidths([], 8, 1)).toEqual([]);
  });
});
