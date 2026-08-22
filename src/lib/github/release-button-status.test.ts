import { describe, expect, it } from "vitest";

import {
  describeReleaseStatusBadge,
  releaseAttentionRank,
  resolveFailedReleaseWorkflow,
  summarizeReleaseButtonStatus,
  summarizeReleaseStatus,
  type ReleaseStatusSummaryInput,
} from "@/lib/github/release-button-status";
import type { ReleaseStatus, ReleaseWorkflowRun } from "@/hooks/use-release-status";

type AvailableReleaseStatus = Extract<ReleaseStatus, { available: true }>;

function baseStatus(overrides: Partial<AvailableReleaseStatus> = {}): AvailableReleaseStatus {
  return {
    available: true,
    mainVersion: "1.0.0",
    developVersion: "1.0.0",
    phase: "none",
    workflowRun: null,
    deployWorkflowRun: null,
    bumpPullRequest: null,
    releasePullRequest: null,
    otherPullRequests: [],
    ...overrides,
  };
}

function workflowRun(overrides: Partial<ReleaseWorkflowRun> = {}): ReleaseWorkflowRun {
  return {
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/example/example/actions/runs/1",
    createdAt: "2026-08-05T00:00:00Z",
    ...overrides,
  };
}

describe("summarizeReleaseButtonStatus", () => {
  it("対象なし（phase: none）はidleを返す", () => {
    expect(summarizeReleaseButtonStatus(baseStatus())).toBe("idle");
  });

  it("前回のデプロイが成功して静止している状態はidleを返す", () => {
    expect(
      summarizeReleaseButtonStatus(
        baseStatus({ deployWorkflowRun: workflowRun({ status: "completed", conclusion: "success" }) }),
      ),
    ).toBe("idle");
  });

  it.each(["success", "failure", "unknown"] as const)(
    "develop→main PRがマージ待ち（release_pr_open）でciStateが%sの場合はaction_requiredを返す",
    (ciState) => {
      expect(
        summarizeReleaseButtonStatus(
          baseStatus({
            phase: "release_pr_open",
            releasePullRequest: {
              number: 1,
              url: "https://github.com/example/example/pull/1",
              title: "release",
              ciState,
              mergeable: null,
              repairWorkflowAvailability: {},
              repairRun: null,
            },
          }),
        ),
      ).toBe("action_required");
    },
  );

  it("develop→main PRがオープン中でもciStateがpendingの間はprogressingを返す（#1433）", () => {
    expect(
      summarizeReleaseButtonStatus(
        baseStatus({
          phase: "release_pr_open",
          releasePullRequest: {
            number: 1,
            url: "https://github.com/example/example/pull/1",
            title: "release",
            ciState: "pending",
            mergeable: null,
            repairWorkflowAvailability: {},
            repairRun: null,
          },
        }),
      ),
    ).toBe("progressing");
  });

  it.each(["success", "failure", "unknown"] as const)(
    "bump PRがオープン中でciStateが%sの場合はaction_requiredを返す（auto-merge滞留の疑い）",
    (ciState) => {
      expect(
        summarizeReleaseButtonStatus(
          baseStatus({
            phase: "bump_pr_open",
            bumpPullRequest: {
              number: 2,
              url: "https://github.com/example/example/pull/2",
              title: "bump",
              ciState,
              mergeable: null,
              repairWorkflowAvailability: {},
              repairRun: null,
              version: "1.1.0",
              reason: null,
              changelog: null,
              usage: null,
            },
          }),
        ),
      ).toBe("action_required");
    },
  );

  it("bump PRがオープン中でciStateがpendingの場合はprogressingを返す", () => {
    expect(
      summarizeReleaseButtonStatus(
        baseStatus({
          phase: "bump_pr_open",
          bumpPullRequest: {
            number: 2,
            url: "https://github.com/example/example/pull/2",
            title: "bump",
            ciState: "pending",
            mergeable: null,
            repairWorkflowAvailability: {},
            repairRun: null,
            version: "1.1.0",
            reason: null,
            changelog: null,
            usage: null,
          },
        }),
      ),
    ).toBe("progressing");
  });

  it("release_pending（develop→main PR自動作成待ち）はprogressingを返す", () => {
    expect(summarizeReleaseButtonStatus(baseStatus({ phase: "release_pending" }))).toBe("progressing");
  });

  it("自動化workflowが実行中（未完了）はprogressingを返す", () => {
    expect(
      summarizeReleaseButtonStatus(baseStatus({ workflowRun: workflowRun({ status: "in_progress", conclusion: null }) })),
    ).toBe("progressing");
  });

  it("本番デプロイworkflowが実行中（未完了）はprogressingを返す", () => {
    expect(
      summarizeReleaseButtonStatus(
        baseStatus({ deployWorkflowRun: workflowRun({ status: "in_progress", conclusion: null }) }),
      ),
    ).toBe("progressing");
  });

  it("本番デプロイworkflowが失敗（completedかつconclusion !== success）はerrorを返す", () => {
    expect(
      summarizeReleaseButtonStatus(
        baseStatus({ deployWorkflowRun: workflowRun({ status: "completed", conclusion: "failure" }) }),
      ),
    ).toBe("error");
  });

  it("リリースworkflow自体が失敗（completedかつconclusion !== success）はerrorを返す", () => {
    expect(
      summarizeReleaseButtonStatus(
        baseStatus({ workflowRun: workflowRun({ status: "completed", conclusion: "failure" }) }),
      ),
    ).toBe("error");
  });

  it("リリースworkflow自体の失敗はrelease_pr_openより優先してerrorを返す", () => {
    expect(
      summarizeReleaseButtonStatus(
        baseStatus({
          phase: "release_pr_open",
          releasePullRequest: {
            number: 1,
            url: "https://github.com/example/example/pull/1",
            title: "release",
            ciState: "success",
            mergeable: null,
            repairWorkflowAvailability: {},
            repairRun: null,
          },
          workflowRun: workflowRun({ status: "completed", conclusion: "failure" }),
        }),
      ),
    ).toBe("error");
  });

  it("デプロイ失敗はrelease_pr_openより優先してerrorを返す", () => {
    expect(
      summarizeReleaseButtonStatus(
        baseStatus({
          phase: "release_pr_open",
          releasePullRequest: {
            number: 1,
            url: "https://github.com/example/example/pull/1",
            title: "release",
            ciState: "success",
            mergeable: null,
            repairWorkflowAvailability: {},
            repairRun: null,
          },
          deployWorkflowRun: workflowRun({ status: "completed", conclusion: "failure" }),
        }),
      ),
    ).toBe("error");
  });
});

function summaryInput(
  overrides: Partial<ReleaseStatusSummaryInput> = {},
): ReleaseStatusSummaryInput {
  return {
    workflowRun: null,
    deployWorkflowRun: null,
    bumpPullRequest: null,
    releasePullRequest: null,
    releasePending: false,
    ...overrides,
  };
}

describe("summarizeReleaseStatus", () => {
  it("何も動いていなければidleを返す", () => {
    expect(summarizeReleaseStatus(summaryInput())).toBe("idle");
  });

  it("develop→mainのPRのCIがpendingの間はprogressing、通過後はaction_requiredを返す（#1433）", () => {
    expect(
      summarizeReleaseStatus(summaryInput({ releasePullRequest: { ciState: "pending" } })),
    ).toBe("progressing");
    expect(
      summarizeReleaseStatus(summaryInput({ releasePullRequest: { ciState: "success" } })),
    ).toBe("action_required");
  });

  it("バンプPRのCIがpendingの間はprogressing、通過後はaction_requiredを返す", () => {
    expect(summarizeReleaseStatus(summaryInput({ bumpPullRequest: { ciState: "pending" } }))).toBe(
      "progressing",
    );
    expect(summarizeReleaseStatus(summaryInput({ bumpPullRequest: { ciState: "success" } }))).toBe(
      "action_required",
    );
  });

  it("PRが無くてもリリースworkflowが実行中ならprogressingを返す", () => {
    expect(
      summarizeReleaseStatus(
        summaryInput({ workflowRun: { status: "in_progress", conclusion: null } }),
      ),
    ).toBe("progressing");
  });

  it("失敗はマージ待ちより優先してerrorを返す", () => {
    expect(
      summarizeReleaseStatus(
        summaryInput({
          releasePullRequest: { ciState: "success" },
          deployWorkflowRun: { status: "completed", conclusion: "failure" },
        }),
      ),
    ).toBe("error");
  });
});

describe("resolveFailedReleaseWorkflow", () => {
  it("失敗していなければnullを返す", () => {
    expect(
      resolveFailedReleaseWorkflow(
        summaryInput({ workflowRun: { status: "completed", conclusion: "success" } }),
      ),
    ).toBeNull();
  });

  it("本番デプロイの失敗をリリースworkflowの失敗より優先して返す", () => {
    expect(
      resolveFailedReleaseWorkflow(
        summaryInput({
          workflowRun: { status: "completed", conclusion: "failure" },
          deployWorkflowRun: { status: "completed", conclusion: "failure" },
        }),
      ),
    ).toBe("deploy");
  });

  it("リリースworkflowだけが失敗している場合はreleaseを返す", () => {
    expect(
      resolveFailedReleaseWorkflow(
        summaryInput({ workflowRun: { status: "completed", conclusion: "failure" } }),
      ),
    ).toBe("release");
  });
});

describe("describeReleaseStatusBadge", () => {
  it("idleはバッジを出さない", () => {
    expect(
      describeReleaseStatusBadge({
        status: "idle",
        failedWorkflow: null,
        mergeTarget: null,
        ciState: null,
      }),
    ).toBeNull();
  });

  it("マージ待ちはマージ先を文言に含める", () => {
    expect(
      describeReleaseStatusBadge({
        status: "action_required",
        failedWorkflow: null,
        mergeTarget: "main",
        ciState: "success",
      }),
    ).toEqual({ label: "mainへマージ待ち", tone: "action" });
    expect(
      describeReleaseStatusBadge({
        status: "action_required",
        failedWorkflow: null,
        mergeTarget: "develop",
        ciState: "success",
      }),
    ).toEqual({ label: "developへマージ待ち", tone: "action" });
  });

  it("マージ待ちPRのチェックが落ちている場合はマージ先よりチェック失敗を優先する（#1059）", () => {
    expect(
      describeReleaseStatusBadge({
        status: "action_required",
        failedWorkflow: null,
        mergeTarget: "main",
        ciState: "failure",
      }),
    ).toEqual({ label: "チェック失敗", tone: "error" });
  });

  it("失敗はデプロイとリリースworkflowで文言を書き分ける", () => {
    expect(
      describeReleaseStatusBadge({
        status: "error",
        failedWorkflow: "deploy",
        mergeTarget: null,
        ciState: null,
      }),
    ).toEqual({ label: "デプロイ失敗", tone: "error" });
    expect(
      describeReleaseStatusBadge({
        status: "error",
        failedWorkflow: "release",
        mergeTarget: null,
        ciState: null,
      }),
    ).toEqual({ label: "リリース失敗", tone: "error" });
  });

  it("進行中は実施中を返す", () => {
    expect(
      describeReleaseStatusBadge({
        status: "progressing",
        failedWorkflow: null,
        mergeTarget: null,
        ciState: null,
      }),
    ).toEqual({ label: "実施中", tone: "progressing" });
  });
});

describe("releaseAttentionRank", () => {
  it("失敗・マージ待ち・実施中・静止の順に上へ寄せる", () => {
    const failure = releaseAttentionRank({ status: "error", ciState: null });
    const ciFailure = releaseAttentionRank({ status: "action_required", ciState: "failure" });
    const actionRequired = releaseAttentionRank({ status: "action_required", ciState: "success" });
    const progressing = releaseAttentionRank({ status: "progressing", ciState: null });
    const idle = releaseAttentionRank({ status: "idle", ciState: null });

    expect(failure).toBe(ciFailure);
    expect(failure).toBeLessThan(actionRequired);
    expect(actionRequired).toBeLessThan(progressing);
    expect(progressing).toBeLessThan(idle);
  });

  it("状態が取れていないリポジトリは静止と同じ最下位にする", () => {
    expect(releaseAttentionRank({ status: null, ciState: null })).toBe(
      releaseAttentionRank({ status: "idle", ciState: null }),
    );
  });

  it("同順位のものは安定ソートで元の並びが保たれる", () => {
    const repositories = [
      { fullName: "guchi-apps/aide", status: "idle" as const },
      { fullName: "guchi-apps/asset-manager", status: "action_required" as const },
      { fullName: "guchi-apps/car-care", status: "idle" as const },
      { fullName: "guchi-apps/clip-hive", status: "progressing" as const },
      { fullName: "guchi-apps/dayspan", status: "idle" as const },
    ];

    const sorted = [...repositories].sort(
      (a, b) =>
        releaseAttentionRank({ status: a.status, ciState: null }) -
        releaseAttentionRank({ status: b.status, ciState: null }),
    );

    expect(sorted.map((repo) => repo.fullName)).toEqual([
      "guchi-apps/asset-manager",
      "guchi-apps/clip-hive",
      "guchi-apps/aide",
      "guchi-apps/car-care",
      "guchi-apps/dayspan",
    ]);
  });
});
