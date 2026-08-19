import { describe, expect, it } from "vitest";

import { computeIssueDependents, summarizeIssueDependents } from "@/lib/issue-dependents";
import type { Issue } from "@/types/issue";

const REPO = "guchi-apps/subpc";
const MANUAL_STEP_LABEL = { name: "71.manual-step", color: "d876e3", description: null };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const number = overrides.number ?? 1;
  return {
    id: String(number),
    number,
    title: "サンプルIssue",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: REPO,
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
    projectStatus: null,
    htmlUrl: `https://github.com/${REPO}/issues/${number}`,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

/** guchi-apps/subpc の #38（対応Issue）と #39（先に実施する手作業） */
const MANUAL_STEP = makeIssue({
  number: 39,
  title: "[手作業] サブPC: 停止しているセルフホストランナーを起こす",
  labels: [MANUAL_STEP_LABEL],
  body: "## 関連\n\n- 起点: #38\n",
});
const WAITING = makeIssue({
  number: 38,
  title: "セルフホストランナーが落ちたまま復帰しない",
  projectStatus: "Implementation",
  body: "## 前提条件\n\n- 先に完了している必要があるIssue・PR: #39\n",
});

describe("computeIssueDependents", () => {
  it("自分を`## 前提条件`に挙げているIssueを集める", () => {
    const dependents = computeIssueDependents(MANUAL_STEP, [WAITING, MANUAL_STEP]);

    expect(dependents).toHaveLength(1);
    expect(dependents[0]).toMatchObject({
      number: 38,
      repositoryFullName: REPO,
      label: "実装中",
      manualStep: false,
    });
  });

  it("待たれていないIssueには何も出さない", () => {
    expect(computeIssueDependents(WAITING, [WAITING, MANUAL_STEP])).toEqual([]);
  });

  // 起点はIssue詳細の「子Issue」がすでに出しており、実際に待っているとは限らない
  it("`## 関連`の起点だけで結ばれた相手は辿らない", () => {
    const origin = makeIssue({ number: 38, title: "起点Issue" });

    expect(computeIssueDependents(origin, [origin, MANUAL_STEP])).toEqual([]);
  });

  it("クローズ済みのIssueは待っていないものとして外す", () => {
    const closed = makeIssue({
      number: 40,
      state: "closed",
      body: "## 前提条件\n\n- #39\n",
    });

    expect(computeIssueDependents(MANUAL_STEP, [closed, MANUAL_STEP])).toEqual([]);
  });

  it("別リポジトリの同番号を取り違えない", () => {
    const other = makeIssue({
      number: 50,
      repositoryFullName: "guchi-apps/issue-deck",
      body: "## 前提条件\n\n- #39\n",
    });

    expect(computeIssueDependents(MANUAL_STEP, [other, MANUAL_STEP])).toEqual([]);
  });

  it("`owner/repo#番号`で書かれた別リポジトリからの参照は拾う", () => {
    const other = makeIssue({
      id: "other-50",
      number: 50,
      repositoryFullName: "guchi-apps/issue-deck",
      body: `## 前提条件\n\n- ${REPO}#39\n`,
    });
    const [first] = computeIssueDependents(MANUAL_STEP, [other, MANUAL_STEP]);

    expect(first).toMatchObject({ number: 50, repositoryFullName: "guchi-apps/issue-deck" });
  });

  it("進んでいるものから並べる", () => {
    const ready = makeIssue({ number: 41, projectStatus: "Ready", body: "## 前提条件\n\n- #39\n" });
    const develop = makeIssue({
      number: 42,
      projectStatus: "Develop",
      body: "## 前提条件\n\n- #39\n",
    });

    expect(
      computeIssueDependents(MANUAL_STEP, [ready, develop, MANUAL_STEP]).map(
        (dependent) => dependent.number,
      ),
    ).toEqual([42, 41]);
  });
});

describe("summarizeIssueDependents", () => {
  it("待たせている相手を1件だけ名指しし、残りは件数で添える", () => {
    const dependents = computeIssueDependents(
      MANUAL_STEP,
      [WAITING, makeIssue({ number: 41, body: "## 前提条件\n\n- #39\n" }), MANUAL_STEP],
    );

    expect(summarizeIssueDependents(dependents, REPO)).toBe(
      "このIssueが終わるまで #38 とほか1件は先へ進めません。",
    );
  });

  it("別リポジトリの相手にはリポジトリ名を添える", () => {
    const other = makeIssue({
      id: "other-50",
      number: 50,
      repositoryFullName: "guchi-apps/issue-deck",
      body: `## 前提条件\n\n- ${REPO}#39\n`,
    });
    const dependents = computeIssueDependents(MANUAL_STEP, [other, MANUAL_STEP]);

    expect(summarizeIssueDependents(dependents, REPO)).toBe(
      "このIssueが終わるまで guchi-apps/issue-deck#50 は先へ進めません。",
    );
  });
});
