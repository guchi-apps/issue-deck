import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyIssueFilters,
  computeFilterLabelSummary,
  computeLabelSummary,
  computeNavCountsForFilters,
  computeOverviewStats,
  detectNewlyCheckUserIssues,
  filterIssuesByView,
  getAssigneeOptions,
  groupIssuesByRepository,
  hasIgnoredIssueFilters,
  reconcileIssues,
  resolveFiltersForView,
  sortIssues,
  upsertIssue,
} from "@/lib/issue-stats";
import type { IssueFilters } from "@/hooks/use-issue-filters";
import { NAV_VIEW_IDS } from "@/types/issue";
import type { Issue, NavViewId } from "@/types/issue";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "1",
    number: 1,
    title: "サンプルIssue",
    body: "本文のテキスト",
    state: "open",
    stateReason: null,
    repositoryFullName: "owner/repo",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/owner/repo/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

const DEFAULT_FILTERS: Pick<IssueFilters, "q" | "repos" | "state" | "labels" | "assignee"> = {
  q: "",
  repos: [],
  state: "all",
  labels: [],
  assignee: null,
};

describe("applyIssueFilters", () => {
  it("qが検索クエリに一致しないIssueを除外する", () => {
    const issues = [makeIssue({ id: "1", title: "foo" }), makeIssue({ id: "2", title: "bar" })];
    const result = applyIssueFilters(issues, { ...DEFAULT_FILTERS, q: "foo" });
    expect(result.map((issue) => issue.id)).toEqual(["1"]);
  });

  // #1788: AIあいまい検索は自由語の部分一致の代わりにid集合で絞る
  it("aiMatchedIdsがあるときは、文字列一致しないIssueでもAIが選んだものを残す", () => {
    const issues = [makeIssue({ id: "1", title: "foo" }), makeIssue({ id: "2", title: "bar" })];
    const result = applyIssueFilters(issues, {
      ...DEFAULT_FILTERS,
      q: "存在しない語",
      aiMatchedIds: new Set(["2"]),
    });
    expect(result.map((issue) => issue.id)).toEqual(["2"]);
  });

  it("aiMatchedIdsとlabel:トークンは併用できる", () => {
    const issues = [
      makeIssue({ id: "1", labels: [{ name: "bug", color: "red", description: null }] }),
      makeIssue({ id: "2", labels: [] }),
    ];
    const result = applyIssueFilters(issues, {
      ...DEFAULT_FILTERS,
      q: "label:bug 重い",
      aiMatchedIds: new Set(["1", "2"]),
    });
    expect(result.map((issue) => issue.id)).toEqual(["1"]);
  });

  it("reposが一致しないIssueを除外する", () => {
    const issues = [
      makeIssue({ id: "1", repositoryFullName: "owner/repo-a" }),
      makeIssue({ id: "2", repositoryFullName: "owner/repo-b" }),
    ];
    const result = applyIssueFilters(issues, { ...DEFAULT_FILTERS, repos: ["owner/repo-a"] });
    expect(result.map((issue) => issue.id)).toEqual(["1"]);
  });

  it("reposを複数指定するといずれかに一致するIssueを残す", () => {
    const issues = [
      makeIssue({ id: "1", repositoryFullName: "owner/repo-a" }),
      makeIssue({ id: "2", repositoryFullName: "owner/repo-b" }),
      makeIssue({ id: "3", repositoryFullName: "owner/repo-c" }),
    ];
    const result = applyIssueFilters(issues, {
      ...DEFAULT_FILTERS,
      repos: ["owner/repo-a", "owner/repo-b"],
    });
    expect(result.map((issue) => issue.id)).toEqual(["1", "2"]);
  });

  it("stateがallでない場合は一致しないIssueを除外する", () => {
    const issues = [makeIssue({ id: "1", state: "open" }), makeIssue({ id: "2", state: "closed" })];
    const result = applyIssueFilters(issues, { ...DEFAULT_FILTERS, state: "closed" });
    expect(result.map((issue) => issue.id)).toEqual(["2"]);
  });

  it("labelsのいずれかを持つIssueのみ残す", () => {
    const issues = [
      makeIssue({ id: "1", labels: [{ name: "bug", color: "red", description: null }] }),
      makeIssue({ id: "2", labels: [{ name: "docs", color: "blue", description: null }] }),
      makeIssue({ id: "3", labels: [] }),
    ];
    const result = applyIssueFilters(issues, { ...DEFAULT_FILTERS, labels: ["bug", "docs"] });
    expect(result.map((issue) => issue.id)).toEqual(["1", "2"]);
  });

  it("assignee: unassignedは未担当のIssueのみ残す", () => {
    const issues = [
      makeIssue({ id: "1", assignee: null }),
      makeIssue({ id: "2", assignee: { login: "octocat" } }),
    ];
    const result = applyIssueFilters(issues, { ...DEFAULT_FILTERS, assignee: "unassigned" });
    expect(result.map((issue) => issue.id)).toEqual(["1"]);
  });

  it("assigneeにログイン名を指定すると一致するIssueのみ残す", () => {
    const issues = [
      makeIssue({ id: "1", assignee: { login: "octocat" } }),
      makeIssue({ id: "2", assignee: { login: "other" } }),
    ];
    const result = applyIssueFilters(issues, { ...DEFAULT_FILTERS, assignee: "octocat" });
    expect(result.map((issue) => issue.id)).toEqual(["1"]);
  });
});

describe("sortIssues", () => {
  it("sort=updatedはupdatedAtの降順で並べる", () => {
    const issues = [
      makeIssue({ id: "1", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeIssue({ id: "2", updatedAt: "2026-01-03T00:00:00.000Z" }),
      makeIssue({ id: "3", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const result = sortIssues(issues, "updated");
    expect(result.map((issue) => issue.id)).toEqual(["2", "3", "1"]);
  });

  it("sort=createdはcreatedAtの降順で並べる", () => {
    const issues = [
      makeIssue({ id: "1", createdAt: "2026-01-02T00:00:00.000Z" }),
      makeIssue({ id: "2", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const result = sortIssues(issues, "created");
    expect(result.map((issue) => issue.id)).toEqual(["1", "2"]);
  });

  it("元の配列を変更しない", () => {
    const issues = [
      makeIssue({ id: "1", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeIssue({ id: "2", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    sortIssues(issues, "updated");
    expect(issues.map((issue) => issue.id)).toEqual(["1", "2"]);
  });

  it("view=check-userの場合、sort指定によらずlastCommentAtの古い順で並べる", () => {
    const issues = [
      makeIssue({ id: "1", lastCommentAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeIssue({ id: "2", lastCommentAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" }),
      makeIssue({ id: "3", lastCommentAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const result = sortIssues(issues, "updated", "check-user");
    expect(result.map((issue) => issue.id)).toEqual(["2", "3", "1"]);
  });

  it("view=check-userでlastCommentAtが無い場合、checkUserLabeledAtにフォールバックする", () => {
    const issues = [
      makeIssue({ id: "1", lastCommentAt: null, checkUserLabeledAt: "2026-01-03T00:00:00.000Z" }),
      makeIssue({ id: "2", lastCommentAt: "2026-01-01T00:00:00.000Z", checkUserLabeledAt: "2026-01-05T00:00:00.000Z" }),
    ];
    const result = sortIssues(issues, "created", "check-user");
    expect(result.map((issue) => issue.id)).toEqual(["2", "1"]);
  });

  it("view=check-userでlastCommentAt・checkUserLabeledAtどちらも無いIssueは最も古いものとして先頭に来る", () => {
    const issues = [
      makeIssue({ id: "1", checkUserLabeledAt: "2026-01-01T00:00:00.000Z" }),
      makeIssue({ id: "2", checkUserLabeledAt: null, lastCommentAt: null }),
    ];
    const result = sortIssues(issues, "created", "check-user");
    expect(result.map((issue) => issue.id)).toEqual(["2", "1"]);
  });
});

describe("getAssigneeOptions", () => {
  it("重複しないassigneeのログイン名をソートして返す", () => {
    const issues = [
      makeIssue({ id: "1", assignee: { login: "bob" } }),
      makeIssue({ id: "2", assignee: { login: "alice" } }),
      makeIssue({ id: "3", assignee: { login: "bob" } }),
      makeIssue({ id: "4", assignee: null }),
    ];
    expect(getAssigneeOptions(issues)).toEqual(["alice", "bob"]);
  });
});

describe("groupIssuesByRepository", () => {
  it("repositoryFullNameの昇順でグループ化し、渡された順序をグループ内で保つ", () => {
    const issues = [
      makeIssue({ id: "1", repositoryFullName: "owner/repo-b", updatedAt: "2026-01-02T00:00:00.000Z" }),
      makeIssue({ id: "2", repositoryFullName: "owner/repo-a", updatedAt: "2026-01-03T00:00:00.000Z" }),
      makeIssue({ id: "3", repositoryFullName: "owner/repo-b", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const groups = groupIssuesByRepository(issues);
    expect(groups.map((group) => group.repositoryFullName)).toEqual([
      "owner/repo-a",
      "owner/repo-b",
    ]);
    expect(groups[1].issues.map((issue) => issue.id)).toEqual(["1", "3"]);
  });

  it("グループにリポジトリのPrivate/Archived情報を含める", () => {
    const issues = [
      makeIssue({
        id: "1",
        repositoryFullName: "owner/repo-a",
        repositoryPrivate: true,
        repositoryArchived: true,
      }),
    ];
    const groups = groupIssuesByRepository(issues);
    expect(groups[0]).toMatchObject({ repositoryPrivate: true, repositoryArchived: true });
  });

  it("sortByLatestClosedAt指定時はリポジトリごとのclosedAt最大値の降順でグループ化する（#922）", () => {
    const issues = [
      makeIssue({ id: "1", repositoryFullName: "owner/repo-a", closedAt: "2026-01-01T00:00:00.000Z" }),
      makeIssue({ id: "2", repositoryFullName: "owner/repo-b", closedAt: "2026-01-03T00:00:00.000Z" }),
      makeIssue({ id: "3", repositoryFullName: "owner/repo-b", closedAt: "2026-01-02T00:00:00.000Z" }),
      makeIssue({ id: "4", repositoryFullName: "owner/repo-c", closedAt: null }),
    ];
    const groups = groupIssuesByRepository(issues, { sortByLatestClosedAt: true });
    expect(groups.map((group) => group.repositoryFullName)).toEqual([
      "owner/repo-b",
      "owner/repo-a",
      "owner/repo-c",
    ]);
  });
});

describe("computeLabelSummary", () => {
  it("ラベルごとの件数を集計し件数の降順で返す", () => {
    const issues = [
      makeIssue({ id: "1", labels: [{ name: "bug", color: "red", description: null }] }),
      makeIssue({
        id: "2",
        labels: [
          { name: "bug", color: "red", description: null },
          { name: "docs", color: "blue", description: null },
        ],
      }),
    ];
    expect(computeLabelSummary(issues)).toEqual([
      { name: "bug", color: "red", count: 2 },
      { name: "docs", color: "blue", count: 1 },
    ]);
  });

  it("keepLabelNamesに渡したラベルは該当0件でも件数0で残す", () => {
    const issues = [
      makeIssue({ id: "1", labels: [{ name: "bug", color: "red", description: null }] }),
    ];
    expect(
      computeLabelSummary(issues, {
        keepLabelNames: ["docs"],
        fallbackLabels: [{ name: "docs", color: "blue", count: 5 }],
      }),
    ).toEqual([
      { name: "bug", color: "red", count: 1 },
      { name: "docs", color: "blue", count: 0 },
    ]);
  });

  it("keepLabelNamesのラベルが既に含まれていれば件数を上書きしない", () => {
    const issues = [
      makeIssue({ id: "1", labels: [{ name: "bug", color: "red", description: null }] }),
    ];
    expect(computeLabelSummary(issues, { keepLabelNames: ["bug"] })).toEqual([
      { name: "bug", color: "red", count: 1 },
    ]);
  });
});

describe("computeFilterLabelSummary", () => {
  const issues = [
    makeIssue({
      id: "1",
      repositoryFullName: "owner/repo-a",
      labels: [{ name: "bug", color: "red", description: null }],
    }),
    makeIssue({
      id: "2",
      repositoryFullName: "owner/repo-b",
      labels: [{ name: "bug", color: "red", description: null }],
    }),
    makeIssue({
      id: "3",
      repositoryFullName: "owner/repo-b",
      labels: [{ name: "docs", color: "blue", description: null }],
    }),
    makeIssue({
      id: "4",
      state: "closed",
      repositoryFullName: "owner/repo-a",
      labels: [{ name: "bug", color: "red", description: null }],
    }),
  ];

  // #1441: リポジトリを選んでも全リポジトリ分の件数が出ていた
  it("リポジトリを絞り込むと、そのリポジトリのラベルと件数だけを返す", () => {
    expect(
      computeFilterLabelSummary(issues, {
        ...DEFAULT_FILTERS,
        repos: ["owner/repo-a"],
        state: "open",
      }),
    ).toEqual([{ name: "bug", color: "red", count: 1 }]);
  });

  it("状態の絞り込みにも追随する", () => {
    expect(
      computeFilterLabelSummary(issues, {
        ...DEFAULT_FILTERS,
        repos: ["owner/repo-a"],
        state: "all",
      }),
    ).toEqual([{ name: "bug", color: "red", count: 2 }]);
  });

  it("ラベルの絞り込み自体は適用せず、他のラベルの件数を保つ", () => {
    expect(
      computeFilterLabelSummary(issues, {
        ...DEFAULT_FILTERS,
        state: "open",
        labels: ["docs"],
      }),
    ).toEqual([
      { name: "bug", color: "red", count: 2 },
      { name: "docs", color: "blue", count: 1 },
    ]);
  });

  it("選択中のラベルが該当0件になっても、解除できるよう件数0で残す", () => {
    expect(
      computeFilterLabelSummary(
        issues,
        { ...DEFAULT_FILTERS, repos: ["owner/repo-a"], state: "open", labels: ["docs"] },
        [{ name: "docs", color: "blue", count: 1 }],
      ),
    ).toEqual([
      { name: "bug", color: "red", count: 1 },
      { name: "docs", color: "blue", count: 0 },
    ]);
  });
});


describe("upsertIssue", () => {
  it("新しく作られたIssueは先頭に足す", () => {
    const created = makeIssue({ id: "2" });
    expect(upsertIssue([makeIssue({ id: "1" })], created).map((issue) => issue.id)).toEqual([
      "2",
      "1",
    ]);
  });

  // 作成直後はポーリングが先に反映していることがあり、足すだけだと同じIssueが2行並ぶ（#449）
  it("すでにある同じIssueは置き換える", () => {
    const result = upsertIssue(
      [makeIssue({ id: "1", title: "取得済み" })],
      makeIssue({ id: "1", title: "作成した結果" }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("作成した結果");
  });
});

describe("reconcileIssues", () => {
  it("内容が変わっていないIssueは直前のオブジェクト参照を再利用する", () => {
    const prevIssue = makeIssue({ id: "1" });
    const nextIssue = makeIssue({ id: "1" });
    const result = reconcileIssues([prevIssue], [nextIssue]);
    expect(result[0]).toBe(prevIssue);
  });

  it("内容が変わったIssueは新しいオブジェクトを採用する", () => {
    const prevIssue = makeIssue({ id: "1", title: "old" });
    const nextIssue = makeIssue({ id: "1", title: "new" });
    const result = reconcileIssues([prevIssue], [nextIssue]);
    expect(result[0]).toBe(nextIssue);
  });

  it("新規Issueはそのまま含まれる", () => {
    const nextIssue = makeIssue({ id: "2" });
    const result = reconcileIssues([], [nextIssue]);
    expect(result[0]).toBe(nextIssue);
  });

  // 順番待ちの開始・終了でビューの振り分けが変わるため、参照を使い回すと一覧が追従しない
  it("dispatchPendingAtが変わったIssueは新しいオブジェクトを採用する（#1347）", () => {
    const prevIssue = makeIssue({ id: "1", dispatchPendingAt: null });
    const nextIssue = makeIssue({ id: "1", dispatchPendingAt: "2026-01-09T00:00:00.000Z" });
    const result = reconcileIssues([prevIssue], [nextIssue]);
    expect(result[0]).toBe(nextIssue);
  });
});

describe("detectNewlyCheckUserIssues", () => {
  it("checkUserLabeledAtがnullから非nullに変わったIssueを検知する", () => {
    const prevIssue = makeIssue({ id: "1", checkUserLabeledAt: null });
    const nextIssue = makeIssue({ id: "1", checkUserLabeledAt: "2026-01-05T00:00:00.000Z" });
    const result = detectNewlyCheckUserIssues([prevIssue], [nextIssue]);
    expect(result.map((issue) => issue.id)).toEqual(["1"]);
  });

  it("既にcheckUserLabeledAtが付与済みのIssueは再検知しない", () => {
    const prevIssue = makeIssue({ id: "1", checkUserLabeledAt: "2026-01-01T00:00:00.000Z" });
    const nextIssue = makeIssue({ id: "1", checkUserLabeledAt: "2026-01-01T00:00:00.000Z" });
    const result = detectNewlyCheckUserIssues([prevIssue], [nextIssue]);
    expect(result).toEqual([]);
  });

  it("checkUserLabeledAtがnullのままのIssueは検知しない", () => {
    const prevIssue = makeIssue({ id: "1", checkUserLabeledAt: null });
    const nextIssue = makeIssue({ id: "1", checkUserLabeledAt: null });
    const result = detectNewlyCheckUserIssues([prevIssue], [nextIssue]);
    expect(result).toEqual([]);
  });

  it("直前の配列に存在しない新規Issueは、checkUserLabeledAtが付与済みなら検知する", () => {
    const nextIssue = makeIssue({ id: "2", checkUserLabeledAt: "2026-01-05T00:00:00.000Z" });
    const result = detectNewlyCheckUserIssues([], [nextIssue]);
    expect(result.map((issue) => issue.id)).toEqual(["2"]);
  });

  it("直前の配列に存在しない新規Issueで、checkUserLabeledAtが未付与なら検知しない", () => {
    const nextIssue = makeIssue({ id: "2", checkUserLabeledAt: null });
    const result = detectNewlyCheckUserIssues([], [nextIssue]);
    expect(result).toEqual([]);
  });
});

describe("time-dependent stats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("filterIssuesByView", () => {
    it("view=favoritesはfavorite=trueのIssueのみ返す", () => {
      const issues = [makeIssue({ id: "1", favorite: true }), makeIssue({ id: "2", favorite: false })];
      const result = filterIssuesByView(issues, "favorites", null);
      expect(result.map((issue) => issue.id)).toEqual(["1"]);
    });

    it("view=recently-addedは直近24時間以内に作成されたIssueのみ返す", () => {
      const issues = [
        makeIssue({ id: "1", createdAt: "2026-01-09T12:00:00.000Z" }),
        makeIssue({ id: "2", createdAt: "2026-01-08T00:00:00.000Z" }),
      ];
      const result = filterIssuesByView(issues, "recently-added", null);
      expect(result.map((issue) => issue.id)).toEqual(["1"]);
    });

    it("view=allはすべてのIssueを返す", () => {
      const issues = [makeIssue({ id: "1" }), makeIssue({ id: "2" })];
      expect(filterIssuesByView(issues, "all", null)).toHaveLength(2);
    });

    it("定型ビューは該当する進捗・ラベルを持つIssueのみ返す", () => {
      const issues = [
        makeIssue({ id: "1", labels: [{ name: "00.check-user", color: "red", description: null }] }),
        makeIssue({ id: "2", projectStatus: "Implementation" }),
        makeIssue({ id: "3", projectStatus: "Develop PR" }),
        makeIssue({ id: "4", projectStatus: "Release" }),
        makeIssue({ id: "5", labels: [] }),
      ];
      expect(filterIssuesByView(issues, "check-user", null).map((issue) => issue.id)).toEqual(["1"]);
      expect(filterIssuesByView(issues, "in-progress", null).map((issue) => issue.id)).toEqual([
        "2",
        "3",
      ]);
      expect(filterIssuesByView(issues, "release-pending", null).map((issue) => issue.id)).toEqual([
        "4",
      ]);
    });

    it("view=in-progressは進捗が進んでいなくてもqaAnswerPendingAtが立っていれば返す", () => {
      const issues = [
        makeIssue({ id: "1", labels: [], qaAnswerPendingAt: "2026-01-09T00:00:00.000Z" }),
        makeIssue({ id: "2", labels: [], qaAnswerPendingAt: null }),
        makeIssue({
          id: "3",
          projectStatus: "Done",
          qaAnswerPendingAt: "2026-01-09T00:00:00.000Z",
        }),
      ];
      expect(filterIssuesByView(issues, "in-progress", null).map((issue) => issue.id)).toEqual([
        "1",
        "3",
      ]);
    });

    it("view=not-startedは進捗がReadyかつ00.check-user・71.manual-stepを持たないIssueのみ返す", () => {
      const issues = [
        makeIssue({ id: "1", labels: [] }),
        makeIssue({ id: "2", labels: [{ name: "00.check-user", color: "red", description: null }] }),
        makeIssue({ id: "3", projectStatus: "Implementation" }),
        makeIssue({ id: "4", projectStatus: "Done" }),
        makeIssue({
          id: "5",
          labels: [{ name: "51.improvement", color: "purple", description: null }],
        }),
        makeIssue({
          id: "6",
          labels: [{ name: "71.manual-step", color: "d876e3", description: null }],
        }),
      ];
      expect(filterIssuesByView(issues, "not-started", null).map((issue) => issue.id)).toEqual([
        "1",
        "5",
      ]);
    });

    it("サブPCへ積んだ未完了ジョブがあるIssueは、進捗がReadyでもnot-startedではなくin-progressに出る（#1347）", () => {
      const dispatchPendingAt = "2026-01-09T00:00:00.000Z";
      const issues = [
        makeIssue({ id: "1", dispatchPendingAt }),
        makeIssue({ id: "2", dispatchPendingAt: null }),
      ];
      expect(filterIssuesByView(issues, "in-progress", null).map((issue) => issue.id)).toEqual([
        "1",
      ]);
      expect(filterIssuesByView(issues, "not-started", null).map((issue) => issue.id)).toEqual([
        "2",
      ]);
    });

    it("順番待ちでもuser確認待ち・手作業のビューの母集団は変えない（#1347）", () => {
      const dispatchPendingAt = "2026-01-09T00:00:00.000Z";
      const issues = [
        makeIssue({
          id: "1",
          dispatchPendingAt,
          labels: [{ name: "00.check-user", color: "red", description: null }],
        }),
        makeIssue({
          id: "2",
          dispatchPendingAt,
          labels: [{ name: "71.manual-step", color: "d876e3", description: null }],
        }),
      ];
      expect(filterIssuesByView(issues, "check-user", null).map((issue) => issue.id)).toEqual(["1"]);
      expect(filterIssuesByView(issues, "manual-step", null).map((issue) => issue.id)).toEqual(["2"]);
    });

    it("view=manual-stepは71.manual-stepが付いたIssueのみ返す（進捗は問わない）", () => {
      const manualStepLabel = { name: "71.manual-step", color: "d876e3", description: null };
      const issues = [
        makeIssue({ id: "1", labels: [manualStepLabel] }),
        makeIssue({ id: "2", labels: [] }),
        // 実装が進んだ後に起票された手作業Issueもあるため、進捗では絞り込まない
        makeIssue({ id: "3", labels: [manualStepLabel], projectStatus: "Implementation" }),
      ];
      expect(filterIssuesByView(issues, "manual-step", null).map((issue) => issue.id)).toEqual([
        "1",
        "3",
      ]);
    });

    it("view=questionは質問Issue（新旧どちらの接頭辞も）のみ返す（#1514）", () => {
      const issues = [
        makeIssue({ id: "1", title: "[質問] このリポジトリの構成を教えて" }),
        makeIssue({ id: "2", title: "質問: 旧形式のタイトル" }),
        makeIssue({ id: "3", title: "通常のIssue" }),
        // タイトルの途中に現れるだけのものは質問ではない
        makeIssue({ id: "4", title: "設計の質問: をどう扱うか" }),
      ];
      expect(filterIssuesByView(issues, "question", null).map((issue) => issue.id)).toEqual([
        "1",
        "2",
      ]);
    });

    it("質問Issueは進捗によらずnot-started・in-progressから除外される（#1514）", () => {
      const issues = [
        makeIssue({ id: "1", title: "[質問] 未着手のまま残る質問" }),
        makeIssue({ id: "2", title: "通常のIssue" }),
        // 回答待ちの質問Issueも「実行中」ではなく「質問」に出す（#978の特例より優先する）
        makeIssue({
          id: "3",
          title: "[質問] 回答待ちの質問",
          qaAnswerPendingAt: "2026-01-09T00:00:00.000Z",
        }),
        // 通常のIssueへ質問した場合の回答待ちは、従来どおり「実行中」に出る（#978）
        makeIssue({
          id: "4",
          title: "通常のIssueへの質問",
          qaAnswerPendingAt: "2026-01-09T00:00:00.000Z",
        }),
      ];
      // 4は通常のIssueなので、回答待ちで「実行中」に出つつ進捗がReadyのまま「未着手」にも残る
      // （#978から変わらない既存の挙動）。質問Issueだけが両方から消える。
      expect(filterIssuesByView(issues, "not-started", null).map((issue) => issue.id)).toEqual([
        "2",
        "4",
      ]);
      expect(filterIssuesByView(issues, "in-progress", null).map((issue) => issue.id)).toEqual([
        "4",
      ]);
      expect(filterIssuesByView(issues, "question", null).map((issue) => issue.id)).toEqual([
        "1",
        "3",
      ]);
    });

    it("質問Issueもユーザーの確認待ちビューには出す（#1514）", () => {
      const issues = [
        makeIssue({
          id: "1",
          title: "[質問] 回答が届いた質問",
          labels: [{ name: "00.check-user", color: "red", description: null }],
        }),
        makeIssue({ id: "2", title: "[質問] 確認待ちではない質問" }),
      ];
      expect(filterIssuesByView(issues, "check-user", null).map((issue) => issue.id)).toEqual(["1"]);
    });

    it("view=recently-mergedはリポジトリごとに最新リリース分のみ返す", () => {
      const doneStatus = "Done";
      const issues = [
        // owner/repo-a の最新リリース（同一workflow run内で連続close）
        makeIssue({
          id: "1",
          repositoryFullName: "owner/repo-a",
          state: "closed",
          projectStatus: doneStatus,
          closedAt: "2026-01-09T10:00:00.000Z",
        }),
        makeIssue({
          id: "2",
          repositoryFullName: "owner/repo-a",
          state: "closed",
          projectStatus: doneStatus,
          closedAt: "2026-01-09T10:00:20.000Z",
        }),
        // owner/repo-a の1つ前のリリース
        makeIssue({
          id: "3",
          repositoryFullName: "owner/repo-a",
          state: "closed",
          projectStatus: doneStatus,
          closedAt: "2026-01-05T10:00:00.000Z",
        }),
        // 別リポジトリは別リリースとして扱う
        makeIssue({
          id: "4",
          repositoryFullName: "owner/repo-b",
          state: "closed",
          projectStatus: doneStatus,
          closedAt: "2026-01-02T10:00:00.000Z",
        }),
        // Doneではないclose済みIssueは対象外
        makeIssue({ id: "5", state: "closed", closedAt: "2026-01-09T10:00:10.000Z" }),
      ];
      expect(filterIssuesByView(issues, "recently-merged", null).map((issue) => issue.id)).toEqual([
        "1",
        "2",
        "4",
      ]);
    });

    it("view=recently-mergedの基準時刻は絞り込み前の集合から求める", () => {
      const doneStatus = "Done";
      const latest = makeIssue({
        id: "1",
        state: "closed",
        projectStatus: doneStatus,
        closedAt: "2026-01-09T10:00:00.000Z",
      });
      const previous = makeIssue({
        id: "2",
        state: "closed",
        projectStatus: doneStatus,
        closedAt: "2026-01-05T10:00:00.000Z",
      });
      // 検索などで最新リリース分が絞り込まれて消えても、古いリリース分は現れない
      expect(
        filterIssuesByView([previous], "recently-merged", null, [latest, previous]),
      ).toEqual([]);
    });
  });

  describe("computeNavCountsForFilters", () => {
    const listFilters = {
      q: "",
      repos: [] as string[],
      state: "open" as const,
      labels: [] as string[],
      assignee: null,
    };

    it("各ビューに一致するIssue数を返す", () => {
      const issues = [
        makeIssue({
          id: "1",
          favorite: true,
          createdAt: "2026-01-09T12:00:00.000Z",
          labels: [{ name: "00.check-user", color: "red", description: null }],
        }),
        makeIssue({
          id: "2",
          favorite: false,
          createdAt: "2025-01-01T00:00:00.000Z",
        }),
      ];
      expect(computeNavCountsForFilters(issues, listFilters, "me")).toEqual({
        all: 2,
        favorites: 1,
        "recently-added": 1,
        "check-user": 1,
        "manual-step": 0,
        question: 0,
        "code-review": 0,
        "not-started": 1,
        "in-progress": 0,
        "release-pending": 0,
        "recently-merged": 0,
      });
    });

    // 前提待ちを含む総数は「いま手を動かせば片付く数」として読めない（#1763）
    it("ユーザーの作業待ちは、いま実行できる手作業だけを数える", () => {
      const manualStepLabel = { name: "71.manual-step", color: "d876e3", description: null };
      const origin = makeIssue({ id: "100", number: 100, projectStatus: "Develop" });
      const issues = [
        origin,
        makeIssue({
          id: "101",
          number: 101,
          labels: [manualStepLabel],
          body: "## 前提条件\n\n- なし\n",
        }),
        makeIssue({
          id: "102",
          number: 102,
          labels: [manualStepLabel],
          body: "## 前提条件\n\n- #100 が本番へ出た後\n",
        }),
      ];

      expect(computeNavCountsForFilters(issues, listFilters, null)["manual-step"]).toBe(1);
    });

    // 未確認だけを数えると、読み終えた質問しか無いときに「質問は無い」と読めてしまう（#2070）
    it("質問は一覧に並ぶ件数（確認済み・回答待ちも含む）を数える", () => {
      const issues = [
        makeIssue({ id: "1", title: "[質問] 未確認のもの", hasUnreadComments: true }),
        makeIssue({ id: "2", title: "[質問] 確認済みのもの", hasUnreadComments: false }),
        makeIssue({
          id: "3",
          title: "[質問] 回答待ちのもの",
          hasUnreadComments: true,
          qaAnswerPendingAt: "2026-01-09T00:00:00.000Z",
        }),
      ];

      expect(computeNavCountsForFilters(issues, listFilters, null).question).toBe(3);
    });

    it("状態の絞り込みを適用した件数を返す（close済みを含めない）", () => {
      const issues = [
        makeIssue({ id: "1" }),
        makeIssue({ id: "2", state: "closed", closedAt: "2026-01-09T10:00:00.000Z" }),
      ];

      expect(computeNavCountsForFilters(issues, listFilters, null).all).toBe(1);
    });

    it("ラベル・担当者の絞り込みも適用する", () => {
      const bugLabel = { name: "30.bug", color: "red", description: null };
      const issues = [
        makeIssue({ id: "1", labels: [bugLabel], assignee: { login: "me" } }),
        makeIssue({ id: "2", labels: [bugLabel], assignee: null }),
        makeIssue({ id: "3", labels: [], assignee: { login: "me" } }),
      ];

      expect(
        computeNavCountsForFilters(issues, { ...listFilters, labels: ["30.bug"] }, null).all,
      ).toBe(2);
      expect(
        computeNavCountsForFilters(issues, { ...listFilters, assignee: "me" }, null).all,
      ).toBe(2);
    });

    it("close済みIssueが対象のビューは状態の絞り込みを無視して数える", () => {
      const issues = [
        makeIssue({ id: "1" }),
        makeIssue({
          id: "2",
          state: "closed",
          projectStatus: "Done",
          closedAt: "2026-01-09T10:00:00.000Z",
        }),
      ];

      const counts = computeNavCountsForFilters(issues, listFilters, null);
      expect(counts.all).toBe(1);
      expect(counts["recently-merged"]).toBe(1);
    });

    it("一覧の絞り込み結果と件数が一致する", () => {
      const issues = [
        makeIssue({ id: "1" }),
        makeIssue({ id: "2", state: "closed", closedAt: "2026-01-09T10:00:00.000Z" }),
        makeIssue({ id: "3", assignee: { login: "other" } }),
      ];
      const filters = { ...listFilters, assignee: "other" };

      const displayed = applyIssueFilters(filterIssuesByView(issues, "all", null), filters);
      expect(computeNavCountsForFilters(issues, filters, null).all).toBe(displayed.length);
    });
  });

  // #1750: リポジトリ横断で全体を見るビューは、ユーザーの絞り込みを適用しない
  describe("resolveFiltersForView / hasIgnoredIssueFilters", () => {
    const filters = {
      q: "キーワード",
      repos: ["owner/repo"],
      state: "closed" as const,
      labels: ["30.bug"],
      assignee: "me",
    };

    it("確認待ち・作業待ち・質問では条件を落とし、状態はビューの既定へ戻す", () => {
      for (const view of ["check-user", "manual-step", "question"] as const) {
        expect(resolveFiltersForView(filters, view)).toEqual({
          q: "",
          // キーワードを外すビューでは、AI検索の絞り込み（#1788）も一緒に外す
          aiMatchedIds: null,
          repos: [],
          state: "open",
          labels: [],
          assignee: null,
        });
        expect(hasIgnoredIssueFilters(filters, view)).toBe(true);
      }
    });

    it("それ以外のビューは条件をそのまま使う", () => {
      for (const view of ["all", "not-started", "in-progress", "recently-merged"] as const) {
        expect(resolveFiltersForView(filters, view)).toBe(filters);
        expect(hasIgnoredIssueFilters(filters, view)).toBe(false);
      }
    });

    it("絞り込みが指定されていなければ注記は出さない", () => {
      const empty = { q: "", repos: [], state: "open" as const, labels: [], assignee: null };
      expect(hasIgnoredIssueFilters(empty, "check-user")).toBe(false);
    });
  });

  describe("リポジトリ絞り込みと件数（#1750）", () => {
    const issues = [
      makeIssue({
        id: "1",
        repositoryFullName: "owner/a",
        labels: [{ name: "00.check-user", color: "red", description: null }],
      }),
      makeIssue({
        id: "2",
        repositoryFullName: "owner/b",
        labels: [{ name: "00.check-user", color: "red", description: null }],
      }),
      makeIssue({
        id: "3",
        repositoryFullName: "owner/b",
        labels: [{ name: "71.manual-step", color: "blue", description: null }],
      }),
      // 「質問」の件数は一覧に並ぶ件数（#2070）
      makeIssue({
        id: "4",
        repositoryFullName: "owner/b",
        title: "[質問] これは何ですか",
        hasUnreadComments: true,
      }),
    ];
    const filters = {
      q: "",
      repos: ["owner/a"],
      state: "open" as const,
      labels: [] as string[],
      assignee: null,
    };

    it("リポジトリを絞っても確認待ち・作業待ち・質問の件数は変わらない", () => {
      const counts = computeNavCountsForFilters(issues, filters, null);
      expect(counts["check-user"]).toBe(2);
      expect(counts["manual-step"]).toBe(1);
      expect(counts.question).toBe(1);
    });

    it("それ以外のビューは従来どおり絞り込まれる", () => {
      const counts = computeNavCountsForFilters(issues, filters, null);
      expect(counts.all).toBe(1);
    });

    it("一覧側もリポジトリ絞り込みを適用しない（件数と一致する）", () => {
      const displayed = filterIssuesByView(
        applyIssueFilters(issues, resolveFiltersForView(filters, "check-user")),
        "check-user",
        null,
        issues,
      );
      expect(displayed).toHaveLength(
        computeNavCountsForFilters(issues, filters, null)["check-user"],
      );
    });

    // #2174。エージェントが動いている確認待ちは、開いても押せる操作が無いので数えない。
    // **一覧には残す**ため、行数との差はヘッダーの内訳（`formatCheckUserListCount`）で説明する
    it("実行中の確認待ちは件数から外す（#2174）", () => {
      const counts = computeNavCountsForFilters(
        issues,
        filters,
        null,
        issues,
        new Set(["1"]),
      );
      expect(counts["check-user"]).toBe(1);
    });

    it("実行中の集合を渡さなければ従来どおり全件を数える", () => {
      expect(computeNavCountsForFilters(issues, filters, null, issues)["check-user"]).toBe(2);
    });
  });

  describe("computeOverviewStats", () => {
    // 件数はnavCountsから引くだけなので、Issueの中身ではなく数え上げ済みの値を渡す
    function makeNavCounts(overrides: Partial<Record<NavViewId, number>> = {}) {
      const counts = Object.fromEntries(
        NAV_VIEW_IDS.map((id) => [id, 0]),
      ) as Record<NavViewId, number>;
      return { ...counts, ...overrides };
    }

    it("要対応・実行中・本番反映待ちの3枚を返し、それぞれ遷移先のビューを持つ", () => {
      const stats = computeOverviewStats(
        makeNavCounts({ "check-user": 2, "in-progress": 4, "release-pending": 3 }),
        0,
      );
      expect(stats).toEqual([
        { label: "要対応", value: "2", linkedView: "check-user" },
        { label: "実行中", value: "4", linkedView: "in-progress" },
        { label: "本番反映待ち", value: "3", linkedView: "release-pending" },
      ]);
    });

    it("「要対応」にはユーザーのマージ待ちPRの件数を足す（PCの左メニューと同じ数え方）", () => {
      const stats = computeOverviewStats(makeNavCounts({ "check-user": 2 }), 3);
      expect(stats[0]).toEqual({ label: "要対応", value: "5", linkedView: "check-user" });
    });
  });
});
