import { describe, expect, it } from "vitest";

import {
  canCreateFollowupFromComment,
  getWorkflowStepIndex,
  hasActiveWorkflowStep,
} from "@/lib/github/workflow-status";
import type { IssueLabel } from "@/types/issue";

function labels(...names: string[]): IssueLabel[] {
  return names.map((name) => ({ name, color: "64748b", description: null }));
}

describe("hasActiveWorkflowStep", () => {
  it("実行が進行し得るラベルではtrueを返す", () => {
    expect(hasActiveWorkflowStep(labels("01.planning"))).toBe(true);
    expect(hasActiveWorkflowStep(labels("02.wip"))).toBe(true);
    expect(hasActiveWorkflowStep(labels("03.d:marge"))).toBe(true);
    expect(hasActiveWorkflowStep(labels("07.m:marge"))).toBe(true);
  });

  it("マージ完了後の定常状態ではfalseを返す（ポーリング対象から外す）", () => {
    expect(hasActiveWorkflowStep(labels("05.develop"))).toBe(false);
    expect(hasActiveWorkflowStep(labels("09.main"))).toBe(false);
  });

  it("実装状況ラベルが無い場合はfalseを返す", () => {
    expect(hasActiveWorkflowStep(labels())).toBe(false);
    expect(hasActiveWorkflowStep(labels("bug", "00.check-user"))).toBe(false);
  });

  it("遷移の過渡期に新旧のラベルが同時に付いていても、進行し得る方を優先してtrueを返す", () => {
    // 現在ステップの判定（先頭一致）では05.developになるケース
    expect(getWorkflowStepIndex(labels("05.develop", "07.m:marge"))).toBe(3);
    expect(hasActiveWorkflowStep(labels("05.develop", "07.m:marge"))).toBe(true);
  });
});

describe("canCreateFollowupFromComment", () => {
  it("closedなissueではtrueを返す", () => {
    expect(canCreateFollowupFromComment({ state: "closed", labels: labels() })).toBe(true);
    expect(canCreateFollowupFromComment({ state: "closed", labels: labels("02.wip") })).toBe(true);
  });

  it("openかつdevelopマージ未満の段階ではfalseを返す", () => {
    expect(canCreateFollowupFromComment({ state: "open", labels: labels() })).toBe(false);
    expect(canCreateFollowupFromComment({ state: "open", labels: labels("01.planning") })).toBe(false);
    expect(canCreateFollowupFromComment({ state: "open", labels: labels("02.wip") })).toBe(false);
    expect(canCreateFollowupFromComment({ state: "open", labels: labels("03.d:marge") })).toBe(false);
  });

  it("openでもdevelopマージ以降の段階ではtrueを返す", () => {
    expect(canCreateFollowupFromComment({ state: "open", labels: labels("05.develop") })).toBe(true);
    expect(canCreateFollowupFromComment({ state: "open", labels: labels("07.m:marge") })).toBe(true);
    expect(canCreateFollowupFromComment({ state: "open", labels: labels("09.main") })).toBe(true);
  });
});
