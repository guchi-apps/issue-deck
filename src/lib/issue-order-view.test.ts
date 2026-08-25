import { describe, expect, it } from "vitest";

import { ISSUE_ORDER_CANDIDATE_LIMIT } from "@/lib/claude/limits";
import {
  buildIssueOrderBodyHead,
  buildIssueOrderCandidates,
  buildIssueOrderKey,
  resolveIssueOrderView,
} from "@/lib/issue-order-view";
import type { Issue } from "@/types/issue";

const NOW = new Date("2026-08-17T00:00:00Z");

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 42,
    title: "一覧の絞り込みを共通化する",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "m-guchi" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: "Ready",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/42",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

describe("buildIssueOrderKey", () => {
  it("owner/repo#番号の形にする", () => {
    expect(buildIssueOrderKey(issue())).toBe("guchi-apps/issue-deck#42");
  });
});

describe("buildIssueOrderBodyHead", () => {
  it("画像・URL・HTMLコメント・記法を落として1行に畳む", () => {
    const body = [
      "<!-- issue-deck-agent:implementer -->",
      "## 概要",
      "![画面](https://example.com/api/issues/images/abc-123)",
      "一覧の**絞り込み**が3か所に散っている。",
    ].join("\n");

    expect(buildIssueOrderBodyHead(body)).toBe("概要 一覧の 絞り込み が3か所に散っている。");
  });

  it("長い本文は先頭だけを取る", () => {
    expect(buildIssueOrderBodyHead("あ".repeat(500))).toHaveLength(200);
  });
});

describe("buildIssueOrderCandidates", () => {
  it("キー・タイトル・ラベル・経過日数・本文の冒頭を組み立てる", () => {
    const candidates = buildIssueOrderCandidates(
      [
        issue({
          labels: [{ name: "50.feature", color: "ededed", description: null }],
          body: "絞り込みを共通化する。",
        }),
      ],
      NOW,
    );

    expect(candidates).toEqual([
      {
        key: "guchi-apps/issue-deck#42",
        title: "一覧の絞り込みを共通化する",
        labels: ["50.feature"],
        ageDays: 16,
        bodyHead: "絞り込みを共通化する。",
      },
    ]);
  });

  it("候補は上限まで、一覧の並びのまま渡す", () => {
    const issues = Array.from({ length: ISSUE_ORDER_CANDIDATE_LIMIT + 10 }, (_, index) =>
      issue({ id: String(index), number: index + 1 }),
    );

    const candidates = buildIssueOrderCandidates(issues, NOW);

    expect(candidates).toHaveLength(ISSUE_ORDER_CANDIDATE_LIMIT);
    expect(candidates[0].key).toBe("guchi-apps/issue-deck#1");
  });

  it("作成日時が読めなくても0日として扱う（判定を止めない）", () => {
    const candidates = buildIssueOrderCandidates([issue({ createdAt: "" })], NOW);

    expect(candidates[0].ageDays).toBe(0);
  });
});

describe("resolveIssueOrderView", () => {
  const first = issue({ id: "1", number: 1 });
  const second = issue({ id: "2", number: 2 });
  const third = issue({ id: "3", number: 3 });
  const issues = [first, second, third];

  const result = {
    overview: "共通化を先に片付けます。",
    order: [
      { key: "guchi-apps/issue-deck#1", reason: "他の前提" },
      { key: "guchi-apps/issue-deck#2", reason: "短時間" },
    ],
    skip: [{ key: "guchi-apps/issue-deck#3", reason: "重複している" }],
  };

  it("先頭を1位、以降をrestへ分ける", () => {
    const view = resolveIssueOrderView(result, issues, new Set());

    expect(view.overview).toBe("共通化を先に片付けます。");
    expect(view.top).toEqual({ issue: first, reason: "他の前提" });
    expect(view.rest).toEqual([{ issue: second, reason: "短時間" }]);
    expect(view.skip).toEqual([{ issue: third, reason: "重複している" }]);
  });

  it("見送ったIssueは着手順から外し、次の候補が繰り上がる", () => {
    const view = resolveIssueOrderView(result, issues, new Set(["guchi-apps/issue-deck#1"]));

    expect(view.top).toEqual({ issue: second, reason: "短時間" });
    expect(view.rest).toEqual([]);
  });

  // 見送りは「着手する順番」への操作なので、やらない候補の提示までは消さない
  it("見送り候補は見送り操作の影響を受けない", () => {
    const view = resolveIssueOrderView(result, issues, new Set(["guchi-apps/issue-deck#3"]));

    expect(view.skip).toEqual([{ issue: third, reason: "重複している" }]);
  });

  it("一覧から消えた（closeされた）Issueは行にしない", () => {
    const view = resolveIssueOrderView(result, [second, third], new Set());

    expect(view.top).toEqual({ issue: second, reason: "短時間" });
    expect(view.rest).toEqual([]);
  });

  it("判定していないときは空の結果を返す", () => {
    expect(resolveIssueOrderView(null, issues, new Set())).toEqual({
      overview: "",
      top: null,
      rest: [],
      skip: [],
    });
  });
});
