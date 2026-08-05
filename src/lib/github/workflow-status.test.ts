import { describe, expect, it } from "vitest";

import { getWorkflowStepIndex, hasActiveWorkflowStep } from "@/lib/github/workflow-status";
import type { IssueLabel } from "@/types/issue";

function labels(...names: string[]): IssueLabel[] {
  return names.map((name) => ({ name, color: "64748b", description: null }));
}

describe("hasActiveWorkflowStep", () => {
  it("実行が進行し得るラベルではtrueを返す", () => {
    expect(hasActiveWorkflowStep(labels("01.wip"))).toBe(true);
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
    expect(getWorkflowStepIndex(labels("05.develop", "07.m:marge"))).toBe(2);
    expect(hasActiveWorkflowStep(labels("05.develop", "07.m:marge"))).toBe(true);
  });
});
