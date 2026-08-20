import { describe, expect, it } from "vitest";

import {
  isPendingPullRequestDeployStatus,
  resolvePullRequestDeployStatus,
  type DeployTargetPullRequest,
  type MainMergedPullRequest,
} from "@/lib/pull-request-deploy";
import type { BranchFlowDeployRun } from "@/types/branch-flow";

const NOW = new Date("2026-08-16T12:00:00Z").getTime();

function target(overrides: Partial<DeployTargetPullRequest> = {}): DeployTargetPullRequest {
  return {
    number: 42,
    title: "PR詳細に本番デプロイ状況を表示する",
    baseRef: "develop",
    merged: true,
    mergedAt: "2026-08-16T10:00:00Z",
    ...overrides,
  };
}

function release(overrides: Partial<MainMergedPullRequest> = {}): MainMergedPullRequest {
  return {
    number: 100,
    title: "v4.1.0をmainへリリースする",
    mergedAt: "2026-08-16T11:00:00Z",
    ...overrides,
  };
}

function deployRun(overrides: Partial<BranchFlowDeployRun> = {}): BranchFlowDeployRun {
  return {
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    createdAt: "2026-08-16T11:01:00Z",
    event: "push",
    ...overrides,
  };
}

describe("resolvePullRequestDeployStatus", () => {
  it("未マージのPRは判定しない（nullを返す）", () => {
    expect(
      resolvePullRequestDeployStatus({
        pullRequest: target({ merged: false, mergedAt: null }),
        releases: [release()],
        deployRun: deployRun(),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("developへマージ済みで、まだ運んだリリースが無ければdevelop-only", () => {
    const status = resolvePullRequestDeployStatus({
      pullRequest: target({ mergedAt: "2026-08-16T11:30:00Z" }),
      releases: [release()],
      deployRun: deployRun(),
      now: NOW,
    });
    expect(status).toEqual({
      kind: "develop-only",
      version: null,
      releasePullRequestNumber: null,
      deployRunUrl: null,
    });
  });

  it("マージ後の最初のリリースが運び、そのデプロイが成功していればdeployed（版とログURL付き）", () => {
    const status = resolvePullRequestDeployStatus({
      pullRequest: target(),
      releases: [
        release({ number: 90, title: "v4.0.0をmainへリリースする", mergedAt: "2026-08-16T09:00:00Z" }),
        release(),
      ],
      deployRun: deployRun(),
      now: NOW,
    });
    expect(status).toEqual({
      kind: "deployed",
      version: "4.1.0",
      releasePullRequestNumber: 100,
      deployRunUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    });
  });

  it("デプロイが実行中ならrunning", () => {
    const status = resolvePullRequestDeployStatus({
      pullRequest: target(),
      releases: [release()],
      deployRun: deployRun({ status: "in_progress", conclusion: null }),
      now: NOW,
    });
    expect(status?.kind).toBe("running");
    expect(status?.version).toBe("4.1.0");
  });

  it("デプロイが失敗していればfailed（mainには入っているが本番には出ていない）", () => {
    const status = resolvePullRequestDeployStatus({
      pullRequest: target(),
      releases: [release()],
      deployRun: deployRun({ conclusion: "failure" }),
      now: NOW,
    });
    expect(status?.kind).toBe("failed");
  });

  it("リリースのマージより後の実行がまだ現れていなければwaiting", () => {
    const status = resolvePullRequestDeployStatus({
      pullRequest: target(),
      releases: [release({ mergedAt: "2026-08-16T11:55:00Z" })],
      deployRun: deployRun({ createdAt: "2026-08-16T09:00:00Z" }),
      now: NOW,
    });
    expect(status).toEqual({
      kind: "waiting",
      version: "4.1.0",
      releasePullRequestNumber: 100,
      deployRunUrl: null,
    });
  });

  it("待ち続けて15分を過ぎたら判定を諦める（deploy.ymlがpushで走らないリポジトリ）", () => {
    const status = resolvePullRequestDeployStatus({
      pullRequest: target(),
      releases: [release({ mergedAt: "2026-08-16T11:00:00Z" })],
      deployRun: deployRun({ createdAt: "2026-08-16T09:00:00Z" }),
      now: NOW,
    });
    expect(status).toBeNull();
  });

  it("後続のリリースが既に出ている古いPRは、最新の実行を見ずにdeployedとする", () => {
    const status = resolvePullRequestDeployStatus({
      pullRequest: target({ mergedAt: "2026-08-15T10:00:00Z" }),
      releases: [
        release({ number: 90, title: "v4.0.0をmainへリリースする", mergedAt: "2026-08-15T12:00:00Z" }),
        release(),
      ],
      // 最新の実行は失敗しているが、このPRはその前の版で本番へ出ている
      deployRun: deployRun({ conclusion: "failure" }),
      now: NOW,
    });
    expect(status).toEqual({
      kind: "deployed",
      version: "4.0.0",
      releasePullRequestNumber: 90,
      deployRunUrl: null,
    });
  });

  it("mainをbaseとするPR（リリースPR自身）は、自分のマージをmain到達として扱う", () => {
    const status = resolvePullRequestDeployStatus({
      pullRequest: target({
        number: 100,
        title: "v4.1.0をmainへリリースする",
        baseRef: "main",
        mergedAt: "2026-08-16T11:00:00Z",
      }),
      releases: [release()],
      deployRun: deployRun(),
      now: NOW,
    });
    expect(status).toEqual({
      kind: "deployed",
      version: "4.1.0",
      releasePullRequestNumber: 100,
      deployRunUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    });
  });

  it("deploy.ymlの実行を1件も取れないリポジトリでは判定しない", () => {
    expect(
      resolvePullRequestDeployStatus({
        pullRequest: target(),
        releases: [release()],
        deployRun: null,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("mainへのマージを1件も取れていない場合は、develop止まりと言い切らない", () => {
    expect(
      resolvePullRequestDeployStatus({
        pullRequest: target(),
        releases: [],
        deployRun: deployRun(),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("バージョンを読み取れないタイトルのリリースでも状態は返す", () => {
    const status = resolvePullRequestDeployStatus({
      pullRequest: target(),
      releases: [release({ title: "本番へ反映する" })],
      deployRun: deployRun(),
      now: NOW,
    });
    expect(status?.kind).toBe("deployed");
    expect(status?.version).toBeNull();
  });
});

describe("isPendingPullRequestDeployStatus", () => {
  it("デプロイ待ち・デプロイ中だけ追いかける", () => {
    const base = { version: null, releasePullRequestNumber: null, deployRunUrl: null };
    expect(isPendingPullRequestDeployStatus({ kind: "waiting", ...base })).toBe(true);
    expect(isPendingPullRequestDeployStatus({ kind: "running", ...base })).toBe(true);
    expect(isPendingPullRequestDeployStatus({ kind: "deployed", ...base })).toBe(false);
    expect(isPendingPullRequestDeployStatus({ kind: "failed", ...base })).toBe(false);
    expect(isPendingPullRequestDeployStatus({ kind: "develop-only", ...base })).toBe(false);
    expect(isPendingPullRequestDeployStatus(null)).toBe(false);
  });
});
