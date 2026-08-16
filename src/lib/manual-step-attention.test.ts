import { describe, expect, it } from "vitest";

import {
  computeManualStepAttention,
  computeManualStepReadiness,
  formatManualStepListCount,
} from "@/lib/manual-step-attention";
import type { Issue } from "@/types/issue";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: String(overrides.number ?? 1),
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
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function manualStep(number: number, originNumber: number | null, overrides: Partial<Issue> = {}) {
  return makeIssue({
    number,
    title: "[手作業] VPS: .envを更新する",
    labels: [{ name: "71.manual-step", color: "d876e3", description: null }],
    body:
      originNumber === null
        ? "## やること\n\n- [ ] .envを更新する\n"
        : `## 前提条件\n\n- #9999 がマージされた後\n\n## 関連\n\n- 起点Issue: #${originNumber}\n`,
    ...overrides,
  });
}

describe("computeManualStepAttention", () => {
  it("起点Issueが本番へ反映済みなら実行できるものとして数える", () => {
    const origin = makeIssue({ number: 100, state: "closed", projectStatus: "Done" });
    const issues = [origin, manualStep(101, 100)];

    expect(computeManualStepAttention(issues)).toEqual({
      total: 1,
      actionable: 1,
      waitingForPrerequisites: 0,
    });
  });

  it("起点Issueがまだ本番へ出ていなければデプロイ待ちとして数える", () => {
    const origin = makeIssue({ number: 100, projectStatus: "Develop" });
    const issues = [origin, manualStep(101, 100)];

    expect(computeManualStepAttention(issues)).toEqual({
      total: 1,
      actionable: 0,
      waitingForPrerequisites: 1,
    });
  });

  // 見落とすより強調しすぎる方へ倒す
  it("起点を特定できない手作業は実行できるものとして数える", () => {
    expect(computeManualStepAttention([manualStep(101, null)])).toEqual({
      total: 1,
      actionable: 1,
      waitingForPrerequisites: 0,
    });
  });

  it("一覧に載っていない起点Issueも実行できるものとして数える", () => {
    expect(computeManualStepAttention([manualStep(101, 100)])).toEqual({
      total: 1,
      actionable: 1,
      waitingForPrerequisites: 0,
    });
  });

  // 番号はリポジトリごとに振られるため、別リポジトリの同番号を起点と取り違えない
  it("起点Issueは同じリポジトリの中から引く", () => {
    const otherRepoOrigin = makeIssue({
      number: 100,
      repositoryFullName: "guchi-apps/car-care",
      projectStatus: "Implementation",
    });

    expect(computeManualStepAttention([otherRepoOrigin, manualStep(101, 100)])).toEqual({
      total: 1,
      actionable: 1,
      waitingForPrerequisites: 0,
    });
  });

  // 起点だけでなく`## 前提条件`に書かれた参照も待つ相手（#1705。Issue詳細と同じ判定）
  it("前提条件に書かれたIssueがまだ進んでいなければ前提待ちとして数える", () => {
    const origin = makeIssue({ number: 100, state: "closed", projectStatus: "Done" });
    const prerequisite = makeIssue({ number: 9999, projectStatus: "Implementation" });

    expect(computeManualStepAttention([origin, prerequisite, manualStep(101, 100)])).toEqual({
      total: 1,
      actionable: 0,
      waitingForPrerequisites: 1,
    });
  });

  it("closedな手作業Issueと手作業以外のIssueは数えない", () => {
    const issues = [
      makeIssue({ number: 1 }),
      manualStep(101, null, { state: "closed", closedAt: "2026-08-10T00:00:00.000Z" }),
    ];

    expect(computeManualStepAttention(issues)).toEqual({
      total: 0,
      actionable: 0,
      waitingForPrerequisites: 0,
    });
  });

  // 左メニューはリポジトリで絞り込めるが、起点Issueは絞り込みの外にもいる
  it("起点Issueの母集団は絞り込み前の一覧から引ける", () => {
    const origin = makeIssue({ number: 100, projectStatus: "Release" });
    const step = manualStep(101, 100);

    expect(computeManualStepAttention([step], [origin, step])).toEqual({
      total: 1,
      actionable: 0,
      waitingForPrerequisites: 1,
    });
  });
});

// 一覧の行のアイコン（#1763）。件数と同じ判定から作るので、数と印が食い違わない
describe("computeManualStepReadiness", () => {
  it("手作業Issueごとに、いま実行できるかと待っている相手を返す", () => {
    const origin = makeIssue({ number: 100, projectStatus: "Develop" });
    const ready = manualStep(101, null);
    const waiting = manualStep(102, 100);

    const readiness = computeManualStepReadiness([origin, ready, waiting]);

    expect(readiness.get(ready.id)?.ready).toBe(true);
    expect(readiness.get(ready.id)?.message).toBe(
      "前提はすべて満たされています。いま実行できます。",
    );
    expect(readiness.get(waiting.id)?.ready).toBe(false);
    expect(readiness.get(waiting.id)?.blocking.map((item) => item.number)).toEqual([100]);
  });

  // 印を付ける対象は「ユーザーがこれから実行する手作業」だけ
  it("手作業以外のIssueとclosedな手作業Issueは載せない", () => {
    const closed = manualStep(101, null, { state: "closed" });
    const other = makeIssue({ number: 1 });

    expect(computeManualStepReadiness([closed, other]).size).toBe(0);
  });

  it("件数（computeManualStepAttention）と同じ判定になる", () => {
    const origin = makeIssue({ number: 100, projectStatus: "Develop" });
    const issues = [origin, manualStep(101, null), manualStep(102, 100)];

    const readiness = [...computeManualStepReadiness(issues).values()];

    expect(readiness.filter((item) => item.ready).length).toBe(
      computeManualStepAttention(issues).actionable,
    );
  });
});

describe("formatManualStepListCount", () => {
  const origin = makeIssue({ number: 100, projectStatus: "Develop" });
  const issues = [manualStep(101, null), manualStep(102, 100)];
  const readiness = computeManualStepReadiness(issues, [origin, ...issues]);

  // 左メニューは実行できる件数しか出さないため、その差はここで説明する
  it("実行できる件数を先に出し、前提待ちを添える", () => {
    expect(formatManualStepListCount(issues, readiness)).toBe("1件・前提待ち1件");
  });

  it("前提待ちが無ければ件数だけを出す", () => {
    expect(formatManualStepListCount([issues[0]], readiness)).toBe("1件");
  });

  it("手作業Issueが無ければnullを返す（呼び出し側が今までどおりの件数を出す）", () => {
    expect(formatManualStepListCount([makeIssue({ number: 1 })], readiness)).toBeNull();
  });
});
