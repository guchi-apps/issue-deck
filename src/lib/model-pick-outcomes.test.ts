import { describe, expect, it } from "vitest";

import {
  buildModelPickOutcomes,
  jevProbabilityBand,
  modelFamily,
  repairWorkflowKind,
  type ModelPickOutcomeLaunch,
  type ModelPickOutcomeUsage,
} from "@/lib/model-pick-outcomes";

function launch(overrides: Partial<ModelPickOutcomeLaunch> = {}): ModelPickOutcomeLaunch {
  return {
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 100,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    claudeModel: "auto",
    modelPickSource: null,
    modelPickModel: null,
    modelPickProbabilities: null,
    ...overrides,
  };
}

function usage(overrides: Partial<ModelPickOutcomeUsage> = {}): ModelPickOutcomeUsage {
  return {
    source: "local",
    kind: "implementation",
    repository: "issue-deck",
    issueNumber: 100,
    prNumber: null,
    workflowName: null,
    costUsd: 1,
    models: ["claude-opus-5-5"],
    ...overrides,
  };
}

describe("repairWorkflowKind", () => {
  it("callerの表示名から修復の種類を引く", () => {
    expect(repairWorkflowKind("Claude CI Fix")).toBe("ci-fix");
    expect(repairWorkflowKind("Claude Conflict Resolve")).toBe("conflict-resolve");
    expect(repairWorkflowKind("Claude PR Repair")).toBe("pr-repair");
    expect(repairWorkflowKind("Claude Review Fix")).toBe("review-fix");
    expect(repairWorkflowKind("claude-ci-fix")).toBe("ci-fix");
  });

  it("修復以外のワークフローと名前の無い行はnull", () => {
    expect(repairWorkflowKind("Claude Review (develop)")).toBeNull();
    expect(repairWorkflowKind("CI")).toBeNull();
    expect(repairWorkflowKind(null)).toBeNull();
  });
});

describe("modelFamily", () => {
  it("モデルIDとエイリアスを系統へ寄せる", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("opus");
    expect(modelFamily("claude-sonnet-5-5")).toBe("sonnet");
    expect(modelFamily("sonnet")).toBe("sonnet");
    expect(modelFamily("auto")).toBeNull();
    expect(modelFamily(null)).toBeNull();
  });
});

describe("jevProbabilityBand", () => {
  it("Jevの確率をP(sonnet)≥0.7で分ける", () => {
    expect(jevProbabilityBand("jev", { sonnet: 0.7, opus: 0.3 })).toBe("high");
    expect(jevProbabilityBand("jev", { sonnet: 0.69, opus: 0.31 })).toBe("low");
    expect(jevProbabilityBand("jev", null)).toBe("none");
    expect(jevProbabilityBand("ai", { sonnet: 0.9 })).toBe("none");
  });
});

describe("buildModelPickOutcomes", () => {
  it("最初の起動ジョブを判定の記録とし、後続を再起動として数える", () => {
    const summary = buildModelPickOutcomes(
      [
        launch({ createdAt: new Date("2026-10-02T00:00:00Z"), modelPickSource: "manual" }),
        launch({ modelPickSource: "rule", modelPickModel: "opus" }),
      ],
      [usage()],
    );
    expect(summary.issues).toHaveLength(1);
    expect(summary.issues[0]).toMatchObject({ route: "rule", model: "opus", relaunches: 1, overridden: false });
    expect(summary.groups[0]).toMatchObject({ issues: 1, redoIssues: 1, redoRate: 1 });
  });

  it("実際に走ったモデルは実装セッションの主モデルを採り、判定と違えば上書きとして残す", () => {
    const summary = buildModelPickOutcomes(
      [launch({ modelPickSource: "jev", modelPickModel: "sonnet", modelPickProbabilities: { sonnet: 0.8 } })],
      [usage({ models: ["claude-haiku-4-5", "claude-opus-5-5"] })],
    );
    expect(summary.issues[0]).toMatchObject({ model: "opus", overridden: true, jevBand: "high" });
    expect(summary.groups[0]).toMatchObject({ comparable: 1, overridden: 1 });
  });

  it("実装セッションが無ければ判定のモデル、それも無ければunknown", () => {
    const summary = buildModelPickOutcomes(
      [
        launch({ issueNumber: 1, modelPickSource: "ai", modelPickModel: "sonnet" }),
        launch({ issueNumber: 2 }),
      ],
      [],
    );
    expect(summary.issues.map((issue) => [issue.issueNumber, issue.model, issue.route, issue.overridden])).toEqual([
      [1, "sonnet", "ai", false],
      [2, "unknown", "unrecorded", null],
    ]);
  });

  it("修復の実行をGitHub Actions行の表示名で数え、PR番号だけの行は同じPRの別の行からIssueを引く", () => {
    const summary = buildModelPickOutcomes(
      [launch()],
      [
        usage(),
        usage({ source: "github-actions", kind: "actions", workflowName: "Claude CI Fix", prNumber: 200, costUsd: 0.5 }),
        usage({ source: "github-actions", kind: "actions", workflowName: "Claude PR Repair", issueNumber: null, prNumber: 200, costUsd: 0.5 }),
        usage({ source: "github-actions", kind: "actions", workflowName: "Claude Review (develop)", prNumber: 200, costUsd: 0.2 }),
        // 別リポジトリの同じ番号は混ぜない
        usage({ repository: "other-app", source: "github-actions", kind: "actions", workflowName: "Claude CI Fix" }),
      ],
    );
    expect(summary.issues[0].repairs).toEqual({ "ci-fix": 1, "conflict-resolve": 0, "pr-repair": 1, "review-fix": 0 });
    expect(summary.issues[0].costUsd).toBeCloseTo(2.2);
    expect(summary.groups[0]).toMatchObject({ repairs: 2, redoIssues: 1 });
  });

  it("モデル×経路×確率帯でまとめ、やり直し率と平均費用を出す", () => {
    const summary = buildModelPickOutcomes(
      [
        launch({ issueNumber: 1, modelPickSource: "rule", modelPickModel: "sonnet" }),
        launch({ issueNumber: 2, modelPickSource: "rule", modelPickModel: "sonnet" }),
        launch({ issueNumber: 2, createdAt: new Date("2026-10-03T00:00:00Z") }),
      ],
      [
        usage({ issueNumber: 1, models: ["claude-sonnet-5-5"], costUsd: 2 }),
        usage({ issueNumber: 2, models: ["claude-sonnet-5-5"], costUsd: 4 }),
      ],
    );
    expect(summary.groups).toEqual([
      expect.objectContaining({
        model: "sonnet",
        route: "rule",
        jevBand: "none",
        issues: 2,
        redoIssues: 1,
        redoRate: 0.5,
        relaunches: 1,
        totalCostUsd: 6,
        avgCostUsd: 3,
      }),
    ]);
  });
});
