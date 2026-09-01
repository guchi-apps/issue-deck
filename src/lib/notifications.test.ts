import { describe, expect, it } from "vitest";

import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import {
  buildNotifications,
  countBadgeNotifications,
  describeNotificationCount,
  groupNotifications,
  hasErrorNotification,
  type NotificationItem,
} from "@/lib/notifications";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import { buildSnoozeMap } from "@/lib/snooze";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    number: 1,
    title: "サンプルIssue",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function label(name: string) {
  return { name, color: "ffffff", description: null };
}

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: "guchi-apps/issue-deck#100",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 100,
    title: "PRのタイトル",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/100",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-100",
    kind: "issue",
    linkedIssueNumber: 100,
    linkedIssueNumbers: [100],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    issueTitle: "サンプルIssue",
    issueId: "issue-1",
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastReportedAt: "2026-08-01T00:05:00.000Z",
    activity: "RESPONDED",
    activityAt: "2026-08-01T00:05:00.000Z",
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: true,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    ...overrides,
  };
}

function makeReleaseStatus(
  overrides: Partial<RepositoryReleaseStatus> = {},
): RepositoryReleaseStatus {
  return {
    repoFullName: "guchi-apps/issue-deck",
    status: "action_required",
    failedWorkflow: null,
    pendingMerge: {
      mergeTarget: "main",
      pullRequestNumber: 500,
      pullRequestUrl: "https://github.com/guchi-apps/issue-deck/pull/500",
      pullRequestTitle: "リリース v3.23.0",
      ciState: "success",
    },
    ...overrides,
  };
}

function build(
  input: Partial<Parameters<typeof buildNotifications>[0]> = {},
): NotificationItem[] {
  return buildNotifications({
    issues: [],
    pullRequests: [],
    releaseStatuses: null,
    ...input,
  });
}

describe("buildNotifications リリース", () => {
  it("マージ待ちを、そのPRの詳細を開く項目として出す", () => {
    const items = build({ releaseStatuses: [makeReleaseStatus()] });

    expect(items).toHaveLength(1);
    expect(items[0].group).toBe("release");
    expect(items[0].tone).toBe("action");
    expect(items[0].badgeLabel).toBe("mainへマージ待ち");
    expect(items[0].title).toContain("#500");
    expect(items[0].target).toEqual({
      kind: "pull-request",
      pullRequestId: "guchi-apps/issue-deck#500",
    });
  });

  it("自動で進行中（progressing）のリポジトリは出さない", () => {
    const items = build({
      releaseStatuses: [makeReleaseStatus({ status: "progressing", pendingMerge: null })],
    });

    expect(items).toEqual([]);
  });

  it("CIが失敗しているマージ待ちはerrorトーンで出す", () => {
    const items = build({
      releaseStatuses: [
        makeReleaseStatus({
          pendingMerge: { ...makeReleaseStatus().pendingMerge!, ciState: "failure" },
        }),
      ],
    });

    expect(items[0].tone).toBe("error");
    expect(items[0].badgeLabel).toBe("チェック失敗");
    expect(hasErrorNotification(items)).toBe(true);
  });

  it("PRを伴わない実行の失敗はブランチ画面へ送る", () => {
    const items = build({
      releaseStatuses: [
        makeReleaseStatus({ status: "error", failedWorkflow: "deploy", pendingMerge: null }),
      ],
    });

    expect(items[0].badgeLabel).toBe("デプロイ失敗");
    expect(items[0].target).toEqual({ kind: "flow" });
  });
});

describe("buildNotifications 確認待ち・手作業待ち", () => {
  it("応答終了したCodexセッションを内容確認のアクションとして出す", () => {
    const items = build({
      issues: [makeIssue({ id: "issue-1" })],
      sessions: [makeSession()],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      group: "session",
      tone: "action",
      title: "#1 サンプルIssue",
      badgeLabel: "内容を確認",
      target: { kind: "issue", issueId: "issue-1" },
    });
  });

  it("構造化された確認待ちがあるセッションは重複通知しない", () => {
    const items = build({
      issues: [
        makeIssue({ id: "issue-1", labels: [label("00.check-user"), label("01.check-input")] }),
      ],
      sessions: [makeSession()],
    });

    expect(items).toHaveLength(1);
    expect(items[0].group).toBe("check-user");
  });

  it("通常のClaude Code・終了済み・応答中のセッションは出さない", () => {
    const items = build({
      issues: [makeIssue({ id: "issue-1" })],
      sessions: [
        makeSession({ codexThreadKnown: null }),
        makeSession({ tmuxSessionName: "exited", state: "EXITED" }),
        makeSession({ tmuxSessionName: "working", activity: "WORKING" }),
      ],
    });

    expect(items).toEqual([]);
  });

  it("00.check-userの理由ラベルをバッジの文言に出す", () => {
    const items = build({
      issues: [
        makeIssue({
          id: "issue-10",
          number: 10,
          labels: [label("00.check-user"), label("01.check-plan")],
          checkUserLabeledAt: "2026-08-10T00:00:00.000Z",
        }),
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0].group).toBe("check-user");
    expect(items[0].badgeLabel).toBe("計画の承認");
    expect(items[0].target).toEqual({ kind: "issue", issueId: "issue-10" });
  });

  it("回答の確認だけの確認待ちはinfoトーンにする", () => {
    const items = build({
      issues: [
        makeIssue({ labels: [label("00.check-user"), label("01.check-answered")] }),
      ],
    });

    expect(items[0].tone).toBe("info");
    expect(hasErrorNotification(items)).toBe(false);
  });

  it("マージ待ちでも対応PRのCIが実行中なら「CI実行中」として弱める", () => {
    const items = build({
      issues: [
        makeIssue({
          id: "issue-100",
          number: 100,
          labels: [label("00.check-user"), label("01.check-merge")],
        }),
      ],
      pullRequests: [makePullRequest({ linkedIssueNumber: 100, ciState: "pending" })],
    });

    expect(items).toHaveLength(1);
    expect(items[0].group).toBe("check-user");
    expect(items[0].badgeLabel).toBe("CI実行中");
    expect(items[0].tone).toBe("info");
  });

  it("エージェントが実行中の確認待ちは「実行中」として弱める（#2174）", () => {
    const items = build({
      issues: [
        makeIssue({
          id: "issue-100",
          number: 100,
          labels: [label("00.check-user"), label("01.check-plan")],
        }),
      ],
      checkUserRunningIssueIds: new Set(["issue-100"]),
    });

    expect(items).toHaveLength(1);
    expect(items[0].badgeLabel).toBe("実行中");
    expect(items[0].tone).toBe("info");
  });

  it("対応PRのCIが確定していれば「PRのマージ」として出す", () => {
    const items = build({
      issues: [
        makeIssue({
          id: "issue-100",
          number: 100,
          labels: [label("00.check-user"), label("01.check-merge")],
        }),
      ],
      pullRequests: [makePullRequest({ linkedIssueNumber: 100, ciState: "success" })],
    });

    expect(items[0].badgeLabel).toBe("PRのマージ");
    expect(items[0].tone).toBe("action");
  });

  it("計画の承認待ちは対応PRのCIが実行中でも弱めない", () => {
    const items = build({
      issues: [
        makeIssue({
          id: "issue-100",
          number: 100,
          labels: [label("00.check-user"), label("01.check-plan")],
        }),
      ],
      pullRequests: [makePullRequest({ linkedIssueNumber: 100, ciState: "pending" })],
    });

    expect(items[0].badgeLabel).toBe("計画の承認");
    expect(items[0].tone).toBe("action");
  });

  it("71.manual-stepのopenなIssueを手作業待ちとして出す", () => {
    const items = build({
      issues: [
        makeIssue({ id: "issue-20", number: 20, labels: [label("71.manual-step")] }),
        makeIssue({
          id: "issue-21",
          number: 21,
          state: "closed",
          labels: [label("71.manual-step")],
        }),
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0].group).toBe("manual-step");
    expect(items[0].target).toEqual({ kind: "issue", issueId: "issue-20" });
  });

  it("前提条件が残っている手作業Issueは出さない（#1801）", () => {
    const items = build({
      issues: [
        makeIssue({
          id: "manual-waiting",
          number: 20,
          labels: [label("71.manual-step")],
          body: "## 前提条件\n\n- #30 がmainへ反映された後\n",
        }),
        makeIssue({
          id: "manual-ready",
          number: 21,
          labels: [label("71.manual-step")],
          body: "## 前提条件\n\n- #31 がmainへ反映された後\n",
        }),
        // 前提待ち（developまで）と、満たされた前提（mainへ反映済み）の参照先
        makeIssue({ id: "issue-30", number: 30, projectStatus: "Develop" }),
        makeIssue({
          id: "issue-31",
          number: 31,
          state: "closed",
          projectStatus: "Done",
        }),
      ],
    });

    expect(items.map((item) => item.target)).toEqual([{ kind: "issue", issueId: "manual-ready" }]);
  });

  it("状態を取得できない参照しか無い手作業Issueは出す（強調しすぎる方へ倒す）", () => {
    const items = build({
      issues: [
        makeIssue({
          id: "manual-unknown",
          number: 20,
          labels: [label("71.manual-step")],
          body: "## 前提条件\n\n- other-owner/other-repo#900 の完了後\n",
        }),
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0].target).toEqual({ kind: "issue", issueId: "manual-unknown" });
  });
});

describe("buildNotifications Pull Request", () => {
  it("CIが確定したopenなPRを出し、失敗はerrorトーンにする", () => {
    const items = build({
      pullRequests: [
        makePullRequest({ id: "owner/repo#1", number: 1, linkedIssueNumber: null }),
        makePullRequest({
          id: "owner/repo#2",
          number: 2,
          linkedIssueNumber: null,
          ciState: "failure",
        }),
      ],
    });

    expect(items.map((item) => item.badgeLabel)).toEqual(["チェック失敗", "developへマージ待ち"]);
    expect(items[0].tone).toBe("error");
  });

  // CI失敗の自動修正は人の操作なしに走る。走っている最中に赤で通知すると、待てば片付くものと
  // 人が手を動かす必要があるものが区別できない（#2072）。
  it("自動修正が走っているあいだは赤を出さず「自動修正中」にする（#2072）", () => {
    const items = build({
      pullRequests: [
        makePullRequest({
          id: "owner/repo#2",
          number: 2,
          linkedIssueNumber: null,
          ciState: "failure",
          repairRun: { kind: "ci", startedAt: "2026-08-22T09:00:00.000Z", runUrl: null },
        }),
      ],
    });

    expect(items[0].badgeLabel).toBe("自動修正中");
    expect(items[0].tone).toBe("info");
    expect(hasErrorNotification(items)).toBe(false);
  });

  it("CI実行中・ドラフトは出さない（左メニューの「マージ待ち」と同じ母集団）", () => {
    const items = build({
      pullRequests: [
        makePullRequest({ id: "owner/repo#1", number: 1, ciState: "pending" }),
        makePullRequest({ id: "owner/repo#2", number: 2, draft: true }),
      ],
    });

    expect(items).toEqual([]);
  });

  it("Auto-mergeが有効でCIも通っているPRは、放っておけば入るので出さない", () => {
    const items = build({
      pullRequests: [
        makePullRequest({ linkedIssueNumber: null, autoMergeEnabled: true, ciState: "success" }),
      ],
    });

    expect(items).toEqual([]);
  });

  it("Auto-mergeが有効でもCIが失敗していれば出す", () => {
    const items = build({
      pullRequests: [
        makePullRequest({ linkedIssueNumber: null, autoMergeEnabled: true, ciState: "failure" }),
      ],
    });

    expect(items).toHaveLength(1);
  });

  // 判定中は画面のマージボタンが無効（#1968）で、ベルへ出しても押せる操作が無い。
  // 判定のcheck-runはCI状態の集約から外してあるため（#1799）、`ciState`は`success`のまま。
  it("Claudeのレビュー・マージ可否の判定中は出さず、件数にも数えない（#2283）", () => {
    const items = build({
      pullRequests: [
        makePullRequest({
          id: "owner/repo#1",
          number: 1,
          linkedIssueNumber: null,
          ciState: "success",
          mergeJudgement: {
            state: "pending",
            step: "claude-review",
            runUrl: "https://github.com/owner/repo/actions/runs/1",
            aiReview: AI_REVIEW_NONE,
          },
        }),
      ],
    });

    expect(items).toEqual([]);
    expect(countBadgeNotifications(items)).toBe(0);
  });

  // CIが落ちた後も判定が終わるまでの数分はpendingのまま（#2066）。赤い「チェック失敗」が
  // その窓だけ消えないよう、CI失敗は判定中でも出す。
  it("CI失敗は判定中でも出す（#2283）", () => {
    const items = build({
      pullRequests: [
        makePullRequest({
          id: "owner/repo#1",
          number: 1,
          linkedIssueNumber: null,
          ciState: "failure",
          mergeJudgement: {
            state: "pending",
            step: "claude-review",
            runUrl: null,
            aiReview: AI_REVIEW_NONE,
          },
        }),
      ],
    });

    expect(items.map((item) => item.badgeLabel)).toEqual(["チェック失敗"]);
    expect(items[0].tone).toBe("error");
    expect(countBadgeNotifications(items)).toBe(1);
  });

  it("判定が終われば今までどおり出す（#2283）", () => {
    const items = build({
      pullRequests: [
        makePullRequest({
          id: "owner/repo#1",
          number: 1,
          linkedIssueNumber: null,
          ciState: "success",
          mergeJudgement: { state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
        }),
      ],
    });

    expect(items.map((item) => item.badgeLabel)).toEqual(["developへマージ待ち"]);
    expect(countBadgeNotifications(items)).toBe(1);
  });
});

describe("buildNotifications 重複除去", () => {
  it("リリースのマージ待ちとして出したPRは、PRの区分では出さない", () => {
    const items = build({
      releaseStatuses: [makeReleaseStatus()],
      pullRequests: [
        makePullRequest({
          id: "guchi-apps/issue-deck#500",
          number: 500,
          kind: "release",
          baseRef: "main",
          headRef: "develop",
          linkedIssueNumber: null,
        }),
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0].group).toBe("release");
  });

  it("確認待ちとして出したIssueに紐づくPRは、PRの区分では出さない", () => {
    const items = build({
      issues: [
        makeIssue({
          id: "issue-100",
          number: 100,
          labels: [label("00.check-user"), label("01.check-merge")],
        }),
      ],
      pullRequests: [makePullRequest({ linkedIssueNumber: 100 })],
    });

    expect(items).toHaveLength(1);
    expect(items[0].group).toBe("check-user");
  });

  it("同じ番号でもリポジトリが違えば別物として扱う", () => {
    const items = build({
      issues: [
        makeIssue({
          id: "issue-100",
          number: 100,
          repositoryFullName: "guchi-apps/car-care",
          labels: [label("00.check-user")],
        }),
      ],
      pullRequests: [makePullRequest({ linkedIssueNumber: 100 })],
    });

    expect(items.map((item) => item.group)).toEqual(["check-user", "pull-request"]);
  });
});

describe("buildNotifications 並び順", () => {
  it("区分（リリース→確認待ち→PR→手作業）、トーン、待たせている時間の順に並べる", () => {
    const items = build({
      issues: [
        makeIssue({ id: "manual", number: 3, labels: [label("71.manual-step")] }),
        makeIssue({
          id: "new-check",
          number: 4,
          labels: [label("00.check-user")],
          checkUserLabeledAt: "2026-08-12T00:00:00.000Z",
        }),
        makeIssue({
          id: "old-check",
          number: 5,
          labels: [label("00.check-user")],
          checkUserLabeledAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      pullRequests: [makePullRequest({ linkedIssueNumber: null })],
      releaseStatuses: [makeReleaseStatus()],
    });

    expect(items.map((item) => item.group)).toEqual([
      "release",
      "check-user",
      "check-user",
      "pull-request",
      "manual-step",
    ]);
    // 確認待ちの中は待たせている時間が長い順
    expect(items[1].id).toBe("check-user:old-check");
    expect(items[2].id).toBe("check-user:new-check");
  });

  it("groupNotificationsは空の区分を含めない", () => {
    const groups = groupNotifications(
      build({ issues: [makeIssue({ labels: [label("00.check-user")] })] }),
    );

    expect(groups.map((entry) => entry.group)).toEqual(["check-user"]);
  });

  it("対象が無ければ空配列を返す", () => {
    expect(build()).toEqual([]);
    expect(hasErrorNotification([])).toBe(false);
  });
});

describe("バッジの件数（#1936）", () => {
  it("手作業待ちをバッジの件数に数えない", () => {
    const items = build({
      issues: [
        makeIssue({ id: "manual", number: 3, labels: [label("71.manual-step")] }),
        makeIssue({ id: "check", number: 4, labels: [label("00.check-user")] }),
      ],
      releaseStatuses: [makeReleaseStatus()],
    });

    // 一覧には3件（リリース・確認待ち・手作業待ち）並ぶが、バッジは手作業待ちを除いた2件
    expect(items).toHaveLength(3);
    expect(countBadgeNotifications(items)).toBe(2);
  });

  it("手作業待ちしか無ければバッジは0件になる（＝バッジを出さない）", () => {
    const items = build({
      issues: [makeIssue({ id: "manual", number: 3, labels: [label("71.manual-step")] })],
    });

    expect(items).toHaveLength(1);
    expect(countBadgeNotifications(items)).toBe(0);
  });

  it("見出しの件数は、手作業待ちがあるときだけ内訳を添える", () => {
    const withManualStep = build({
      issues: [
        makeIssue({ id: "manual", number: 3, labels: [label("71.manual-step")] }),
        makeIssue({ id: "check", number: 4, labels: [label("00.check-user")] }),
      ],
    });
    expect(describeNotificationCount(withManualStep)).toBe("1件・手作業待ち1件");

    const withoutManualStep = build({
      issues: [makeIssue({ id: "check", number: 4, labels: [label("00.check-user")] })],
    });
    expect(describeNotificationCount(withoutManualStep)).toBe("1件");

    expect(describeNotificationCount([])).toBe("0件");
  });
});

// #2398: 件数からも一覧からも外した項目を、ベルだけが呼び出さないようにする
describe("buildNotifications 保留中", () => {
  const NOW = Date.parse("2026-08-27T12:00:00.000Z");

  it("保留中の確認待ちは出さない", () => {
    const issue = makeIssue({ id: "check", number: 4, labels: [label("00.check-user")] });
    const snoozes = buildSnoozeMap([
      {
        kind: "issue",
        repositoryFullName: issue.repositoryFullName,
        number: issue.number,
        until: "2026-09-01T00:00:00.000Z",
      },
    ]);

    expect(build({ issues: [issue], snoozes, now: NOW })).toEqual([]);
    // 保留を渡さなければ今までどおり出る
    expect(build({ issues: [issue] })).toHaveLength(1);
  });

  it("保留中の手作業待ちも出さない", () => {
    const issue = makeIssue({ id: "manual", number: 5, labels: [label("71.manual-step")] });
    const snoozes = buildSnoozeMap([
      {
        kind: "issue",
        repositoryFullName: issue.repositoryFullName,
        number: issue.number,
        until: null,
      },
    ]);

    expect(build({ issues: [issue], snoozes, now: NOW })).toEqual([]);
  });

  it("期限を過ぎた保留は効かない（通常どおり通知へ戻る）", () => {
    const issue = makeIssue({ id: "check", number: 4, labels: [label("00.check-user")] });
    const snoozes = buildSnoozeMap([
      {
        kind: "issue",
        repositoryFullName: issue.repositoryFullName,
        number: issue.number,
        until: "2026-08-01T00:00:00.000Z",
      },
    ]);

    expect(build({ issues: [issue], snoozes, now: NOW })).toHaveLength(1);
  });
});
