import { describe, expect, it } from "vitest";

import {
  CHECK_USER_TOAST_MAX_HOLD_MS,
  findLinkedPullRequest,
  isMergeAwaitingCi,
  isMergeCheckUser,
  resolveCheckUserToasts,
  type PendingCheckUserToast,
} from "@/lib/check-user-notification";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

function label(name: string) {
  return { name, color: "ffffff", description: null };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-100",
    number: 100,
    title: "サンプルIssue",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/shopping-list",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [label("00.check-user"), label("01.check-merge")],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: "2026-08-16T01:26:27.000Z",
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/shopping-list/issues/100",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: "guchi-apps/shopping-list#146",
    repositoryFullName: "guchi-apps/shopping-list",
    repositoryPrivate: false,
    number: 146,
    title: "PRのタイトル",
    htmlUrl: "https://github.com/guchi-apps/shopping-list/pull/146",
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
    linkedIssueCheckUser: true,
    linkedIssueCheckReason: "merge",
    ciState: "pending",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
    createdAt: "2026-08-16T01:25:36.000Z",
    updatedAt: "2026-08-16T01:25:36.000Z",
    ...overrides,
  };
}

const DETECTED_AT = 1_000_000;

function makePending(overrides: Partial<PendingCheckUserToast> = {}): PendingCheckUserToast {
  const issue = overrides.issue ?? makeIssue();
  return {
    id: `${issue.id}:${issue.checkUserLabeledAt}`,
    issue,
    pullRequestsFetchedAt: "2026-08-16T01:20:00.000Z",
    detectedAt: DETECTED_AT,
    ...overrides,
  };
}

function resolve(
  pending: PendingCheckUserToast[],
  input: Partial<Parameters<typeof resolveCheckUserToasts>[1]> = {},
) {
  return resolveCheckUserToasts(pending, {
    issues: pending.map((item) => item.issue),
    pullRequests: [],
    // 既定は「検知の後に取り直した」状態
    pullRequestsFetchedAt: "2026-08-16T01:26:30.000Z",
    now: DETECTED_AT + 1_000,
    ...input,
  });
}

describe("findLinkedPullRequest", () => {
  it("対応Issue番号とリポジトリが一致するopenなPRを返す", () => {
    const pullRequest = makePullRequest();
    expect(findLinkedPullRequest([pullRequest], makeIssue())).toBe(pullRequest);
  });

  it("リポジトリが違えば同じ番号でも紐づけない", () => {
    const pullRequest = makePullRequest({ repositoryFullName: "guchi-apps/car-care" });
    expect(findLinkedPullRequest([pullRequest], makeIssue())).toBeNull();
  });

  it("クローズ済みのPRは紐づけない", () => {
    const pullRequest = makePullRequest({ state: "closed" });
    expect(findLinkedPullRequest([pullRequest], makeIssue())).toBeNull();
  });
});

describe("isMergeCheckUser", () => {
  it("理由がマージ、または理由ラベルが読めない確認待ちを対象にする", () => {
    expect(isMergeCheckUser(makeIssue())).toBe(true);
    expect(isMergeCheckUser(makeIssue({ labels: [label("00.check-user")] }))).toBe(true);
  });

  it("理由が読めてマージ以外なら対象外", () => {
    const issue = makeIssue({ labels: [label("00.check-user"), label("01.check-input")] });
    expect(isMergeCheckUser(issue)).toBe(false);
  });

  it("00.check-userが付いていなければ対象外", () => {
    expect(isMergeCheckUser(makeIssue({ labels: [] }))).toBe(false);
  });
});

describe("isMergeAwaitingCi", () => {
  it("マージ待ちで対応PRのCIが実行中ならtrue", () => {
    expect(isMergeAwaitingCi(makeIssue(), [makePullRequest()])).toBe(true);
  });

  it("CIが確定していればfalse", () => {
    expect(isMergeAwaitingCi(makeIssue(), [makePullRequest({ ciState: "success" })])).toBe(false);
    expect(isMergeAwaitingCi(makeIssue(), [makePullRequest({ ciState: "failure" })])).toBe(false);
  });

  it("理由が計画の承認・質問への回答ならCIを見ない", () => {
    for (const reason of ["01.check-plan", "01.check-input", "01.check-blocked"]) {
      const issue = makeIssue({ labels: [label("00.check-user"), label(reason)] });
      expect(isMergeAwaitingCi(issue, [makePullRequest()])).toBe(false);
    }
  });

  it("理由ラベルが配られていないリポジトリでは対応PRの有無で判断する", () => {
    const issue = makeIssue({ labels: [label("00.check-user")] });
    expect(isMergeAwaitingCi(issue, [makePullRequest()])).toBe(true);
    expect(isMergeAwaitingCi(issue, [])).toBe(false);
  });

  it("00.check-userが付いていなければ常にfalse", () => {
    const issue = makeIssue({ labels: [label("01.check-merge")] });
    expect(isMergeAwaitingCi(issue, [makePullRequest()])).toBe(false);
  });
});

describe("resolveCheckUserToasts（実行中の保留・#2174）", () => {
  it("エージェントが実行中の間は出さずに持つ", () => {
    const pending = makePending();
    const { ready, held } = resolve([pending], {
      runningIssueIds: new Set([pending.issue.id]),
    });
    expect(ready).toHaveLength(0);
    expect(held).toHaveLength(1);
  });

  it("実行中でも上限を過ぎたら出す", () => {
    const pending = makePending();
    const { ready } = resolve([pending], {
      runningIssueIds: new Set([pending.issue.id]),
      now: DETECTED_AT + CHECK_USER_TOAST_MAX_HOLD_MS,
    });
    expect(ready).toHaveLength(1);
  });

  it("自動マージ可否の判定中も持つ（#2081と同じ`isMergeWaitingForChecks`）", () => {
    const pullRequest = makePullRequest({
      ciState: "success",
      mergeJudgement: { state: "pending", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    });
    const { ready, held } = resolve([makePending()], { pullRequests: [pullRequest] });
    expect(ready).toHaveLength(0);
    expect(held).toHaveLength(1);
  });
});

describe("resolveCheckUserToasts", () => {
  it("対応PRのCIが実行中の間は保留する", () => {
    const pending = makePending();
    const { ready, held } = resolve([pending], { pullRequests: [makePullRequest()] });

    expect(ready).toEqual([]);
    expect(held.map((item) => item.id)).toEqual([pending.id]);
  });

  it("CIが確定したら表示へ回す", () => {
    const pending = makePending();
    const { ready, held } = resolve([pending], {
      pullRequests: [makePullRequest({ ciState: "success" })],
    });

    expect(ready.map((item) => item.id)).toEqual([pending.id]);
    expect(held).toEqual([]);
  });

  it("保留中に確認待ちが解けたものは表示せず捨てる", () => {
    const pending = makePending();
    const { ready, held } = resolve([pending], {
      issues: [makeIssue({ labels: [] })],
      pullRequests: [makePullRequest({ ciState: "success" })],
    });

    expect(ready).toEqual([]);
    expect(held).toEqual([]);
  });

  it("検知の後にPR一覧を取り直せていない間は保留する（作成直後のPRは載っていないため）", () => {
    const pending = makePending();
    const { ready, held } = resolve([pending], {
      pullRequests: [],
      pullRequestsFetchedAt: pending.pullRequestsFetchedAt,
    });

    expect(ready).toEqual([]);
    expect(held).toHaveLength(1);
  });

  it("取り直したうえで対応PRが見つからなければ表示する", () => {
    const pending = makePending();
    const { ready } = resolve([pending], { pullRequests: [] });

    expect(ready.map((item) => item.id)).toEqual([pending.id]);
  });

  it("マージ以外の確認待ちは待たせずに表示する", () => {
    const issue = makeIssue({ labels: [label("00.check-user"), label("01.check-plan")] });
    const pending = makePending({ issue });
    const { ready } = resolve([pending], {
      issues: [issue],
      pullRequests: [makePullRequest()],
      pullRequestsFetchedAt: pending.pullRequestsFetchedAt,
    });

    expect(ready.map((item) => item.id)).toEqual([pending.id]);
  });

  it("上限を過ぎたらCIが実行中でも表示する", () => {
    const pending = makePending();
    const { ready } = resolve([pending], {
      pullRequests: [makePullRequest()],
      now: DETECTED_AT + CHECK_USER_TOAST_MAX_HOLD_MS,
    });

    expect(ready.map((item) => item.id)).toEqual([pending.id]);
  });

  it("表示へ回すときは最新のIssueに差し替える（理由ラベルが後から付く場合があるため）", () => {
    const pending = makePending({ issue: makeIssue({ labels: [label("00.check-user")] }) });
    const latest = makeIssue({ title: "更新後のタイトル" });
    const { ready } = resolve([pending], {
      issues: [latest],
      pullRequests: [makePullRequest({ ciState: "success" })],
    });

    expect(ready[0].issue.title).toBe("更新後のタイトル");
  });
});
