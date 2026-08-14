import { describe, expect, it } from "vitest";

import {
  describeReleaseStatusBadge,
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

  it("develop→main PRがマージ待ち（release_pr_open）はaction_requiredを返す", () => {
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
          },
        }),
      ),
    ).toBe("action_required");
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
              version: "1.1.0",
              reason: null,
              changelog: null,
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
            version: "1.1.0",
            reason: null,
            changelog: null,
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
    releasePullRequestOpen: false,
    releasePending: false,
    ...overrides,
  };
}

describe("summarizeReleaseStatus", () => {
  it("何も動いていなければidleを返す", () => {
    expect(summarizeReleaseStatus(summaryInput())).toBe("idle");
  });

  it("develop→mainのPRがオープン中はaction_requiredを返す", () => {
    expect(summarizeReleaseStatus(summaryInput({ releasePullRequestOpen: true }))).toBe(
      "action_required",
    );
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
          releasePullRequestOpen: true,
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
