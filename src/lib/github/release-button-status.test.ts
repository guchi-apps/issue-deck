import { describe, expect, it } from "vitest";

import { summarizeReleaseButtonStatus } from "@/lib/github/release-button-status";
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
              version: "1.1.0",
              reason: null,
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
            version: "1.1.0",
            reason: null,
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
          },
          deployWorkflowRun: workflowRun({ status: "completed", conclusion: "failure" }),
        }),
      ),
    ).toBe("error");
  });
});
