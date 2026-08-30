import { describe, expect, it } from "vitest";

import { isIssueExecutionPending, type DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  describeIssueExecutionTarget,
  isIssueExecutionStarted,
  resolveIssueExecutionTarget,
} from "@/lib/dispatch/issue-execution-target";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const REPO = "guchi-apps/issue-deck";

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1",
    repositoryFullName: REPO,
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-08-14T00:00:00.000Z",
    lastReportedAt: "2026-08-14T00:00:00.000Z",
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    ...overrides,
  };
}

function job(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: REPO,
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    agent: "claude",
    kind: "LAUNCH",
    status: "QUEUED",
    message: null,
    instruction: null,
    command: null,
    placeholderValues: null,
    resolvedCommand: null,
    manualStepLine: null,
    targetJobId: null,
    previewAction: null,
    exitCode: null,
    commandOutput: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: "2026-08-14T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("resolveIssueExecutionTarget", () => {
  it("材料が何も無ければActionsの実行を期待する（従来どおりの表示に戻す）", () => {
    expect(resolveIssueExecutionTarget({ repositoryFullName: REPO, issueNumber: 1, labels: [] })).toEqual(
      { host: null, expectsActionsRun: true },
    );
  });

  it("セッションがあればホスト名を返し、Actionsの実行は期待しない", () => {
    expect(
      resolveIssueExecutionTarget({
        repositoryFullName: REPO,
        issueNumber: 1,
        labels: [],
        sessions: [session()],
      }),
    ).toEqual({ host: "subpc", expectsActionsRun: false });
  });

  it("セッションが無くてもジョブがあればホスト名を返す", () => {
    expect(
      resolveIssueExecutionTarget({
        repositoryFullName: REPO,
        issueNumber: 1,
        labels: [],
        jobs: [job()],
      }),
    ).toEqual({ host: "subpc", expectsActionsRun: false });
  });

  it("ジョブ・セッションが期限切れで落ちていても、11.localが付いていればActionsを期待しない", () => {
    expect(
      resolveIssueExecutionTarget({
        repositoryFullName: REPO,
        issueNumber: 1,
        labels: [{ name: "11.local" }],
      }),
    ).toEqual({ host: null, expectsActionsRun: false });
  });

  it("別Issue・別リポジトリの記録は使わない", () => {
    expect(
      resolveIssueExecutionTarget({
        repositoryFullName: REPO,
        issueNumber: 1,
        labels: [],
        sessions: [session({ issueNumber: 2 }), session({ repositoryFullName: "guchi-apps/other" })],
        jobs: [job({ issueNumber: 2 })],
      }),
    ).toEqual({ host: null, expectsActionsRun: true });
  });

  it("終わったセッションより生きているセッションのホストを優先する", () => {
    const target = resolveIssueExecutionTarget({
      repositoryFullName: REPO,
      issueNumber: 1,
      labels: [],
      sessions: [
        session({ host: "old-host", state: "GONE", lastReportedAt: "2026-08-14T09:00:00.000Z" }),
        session({ host: "subpc", state: "ALIVE", lastReportedAt: "2026-08-14T08:00:00.000Z" }),
      ],
    });
    expect(target.host).toBe("subpc");
  });

  it("生きているセッションが無ければ直近に報告のあったものを使う", () => {
    const target = resolveIssueExecutionTarget({
      repositoryFullName: REPO,
      issueNumber: 1,
      labels: [],
      sessions: [
        session({ host: "old-host", state: "EXITED", lastReportedAt: "2026-08-14T08:00:00.000Z" }),
        session({ host: "subpc", state: "GONE", lastReportedAt: "2026-08-14T09:00:00.000Z" }),
      ],
    });
    expect(target.host).toBe("subpc");
  });

  it("ジョブが複数あれば直近に作られたものを使う", () => {
    const target = resolveIssueExecutionTarget({
      repositoryFullName: REPO,
      issueNumber: 1,
      labels: [],
      jobs: [
        job({ id: "old", targetHost: "old-host", createdAt: "2026-08-14T08:00:00.000Z" }),
        job({ id: "new", targetHost: "subpc", createdAt: "2026-08-14T09:00:00.000Z" }),
      ],
    });
    expect(target.host).toBe("subpc");
  });
});

describe("describeIssueExecutionTarget", () => {
  it("ホスト名が分かればそれを出す（表記は日本語に直す・#1416）", () => {
    expect(describeIssueExecutionTarget({ host: "subpc", expectsActionsRun: false })).toBe("サブPC");
  });

  it("対応表に無いホストはそのまま出す", () => {
    expect(describeIssueExecutionTarget({ host: "otherpc", expectsActionsRun: false })).toBe(
      "otherpc",
    );
  });

  it("ホスト名が分からず11.localだけなら「ローカル」", () => {
    expect(describeIssueExecutionTarget({ host: null, expectsActionsRun: false })).toBe("ローカル");
  });

  it("何も分からなければ「Actions」", () => {
    expect(describeIssueExecutionTarget({ host: null, expectsActionsRun: true })).toBe("Actions");
  });
});

/**
 * #1815。実行を開始した直後は、進捗もジョブもセッションもまだ画面へ届かない。届いているのは
 * 積むより先に付けている`11.local`だけなので、これを見ないと押した後も同じ開始ボタンが残る。
 */
describe("isIssueExecutionStarted", () => {
  it("`11.local`が付いていれば、ジョブもセッションも無くても始まっているとみなす", () => {
    expect(
      isIssueExecutionStarted({
        job: null,
        blockingSession: null,
        labels: [{ name: "11.local" }],
      }),
    ).toBe(true);
  });

  it("`11.local`が無ければ、実体の有無だけで判断する（従来どおり）", () => {
    expect(
      isIssueExecutionStarted({
        job: null,
        blockingSession: null,
        labels: [{ name: "21.plan-required" }],
      }),
    ).toBe(false);
    expect(
      isIssueExecutionStarted({ job: { status: "QUEUED" }, blockingSession: null, labels: [] }),
    ).toBe(true);
    expect(
      isIssueExecutionStarted({
        job: { status: "SUCCEEDED" },
        blockingSession: session(),
        labels: [],
      }),
    ).toBe(true);
  });

  // 立て直しの導線（枠線の「サブPCで開始」）まで塞がないよう、実体の判定は広げない
  it("`11.local`が付いていても、`isIssueExecutionPending`は実体だけを見る", () => {
    expect(isIssueExecutionPending({ job: null, blockingSession: null })).toBe(false);
  });
});
