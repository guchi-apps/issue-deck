import { describe, expect, it } from "vitest";

import {
  canCreateFollowupFromComment,
  getWorkflowStepIndex,
  hasActiveWorkflowStep,
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
