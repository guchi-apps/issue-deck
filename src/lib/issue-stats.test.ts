import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyIssueFilters,
  computeLabelFilterPresetCounts,
  computeLabelSummary,
  computeNavCounts,
  computeOverviewStats,
  filterIssuesByView,
  getAssigneeOptions,
  reconcileIssues,
  sortIssues,
} from "@/lib/issue-stats";
import type { IssueFilters } from "@/hooks/use-issue-filters";
import type { LabelFilterPreset } from "@/lib/github/approval-labels";
import type { Issue } from "@/types/issue";

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
    htmlUrl: "https://github.com/owner/repo/issues/1",
    favorite: false,
    hasUnreadComments: false,
    ...overrides,
  };
}

const DEFAULT_FILTERS: Pick<IssueFilters, "q" | "repo" | "state" | "labels" | "assignee"> = {
  q: "",
  repo: null,
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

  it("repoが一致しないIssueを除外する", () => {
    const issues = [
      makeIssue({ id: "1", repositoryFullName: "owner/repo-a" }),
      makeIssue({ id: "2", repositoryFullName: "owner/repo-b" }),
    ];
    const result = applyIssueFilters(issues, { ...DEFAULT_FILTERS, repo: "owner/repo-a" });
    expect(result.map((issue) => issue.id)).toEqual(["1"]);
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
});

describe("computeLabelFilterPresetCounts", () => {
  const presets: LabelFilterPreset[] = [
    { key: "check-user", label: "ユーザーの確認待ち", labels: ["00.check-user"] },
    { key: "in-progress", label: "実行中", labels: ["03.d:marge", "07.m:marge"] },
  ];

  it("プリセットごとにラベルOR一致するIssue数を返す", () => {
    const issues = [
      makeIssue({ id: "1", labels: [{ name: "00.check-user", color: "red", description: null }] }),
      makeIssue({ id: "2", labels: [{ name: "03.d:marge", color: "blue", description: null }] }),
      makeIssue({ id: "3", labels: [{ name: "07.m:marge", color: "blue", description: null }] }),
      makeIssue({ id: "4", labels: [] }),
    ];
    expect(computeLabelFilterPresetCounts(issues, presets)).toEqual({
      "check-user": 1,
      "in-progress": 2,
    });
  });

  it("該当するIssueがない場合は0を返す", () => {
    const issues = [makeIssue({ id: "1", labels: [] })];
    expect(computeLabelFilterPresetCounts(issues, presets)).toEqual({
      "check-user": 0,
      "in-progress": 0,
    });
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
    it("view=assignedはcurrentUserLoginが担当のIssueのみ返す", () => {
      const issues = [
        makeIssue({ id: "1", assignee: { login: "me" } }),
        makeIssue({ id: "2", assignee: { login: "other" } }),
      ];
      const result = filterIssuesByView(issues, "assigned", "me");
      expect(result.map((issue) => issue.id)).toEqual(["1"]);
    });

    it("view=createdはcurrentUserLoginが作成したIssueのみ返す", () => {
      const issues = [
        makeIssue({ id: "1", author: { login: "me" } }),
        makeIssue({ id: "2", author: { login: "other" } }),
      ];
      const result = filterIssuesByView(issues, "created", "me");
      expect(result.map((issue) => issue.id)).toEqual(["1"]);
    });

    it("view=favoritesはfavorite=trueのIssueのみ返す", () => {
      const issues = [makeIssue({ id: "1", favorite: true }), makeIssue({ id: "2", favorite: false })];
      const result = filterIssuesByView(issues, "favorites", null);
      expect(result.map((issue) => issue.id)).toEqual(["1"]);
    });

    it("view=recentは直近7日以内に更新されたIssueのみ返す", () => {
      const issues = [
        makeIssue({ id: "1", updatedAt: "2026-01-09T00:00:00.000Z" }),
        makeIssue({ id: "2", updatedAt: "2025-12-01T00:00:00.000Z" }),
      ];
      const result = filterIssuesByView(issues, "recent", null);
      expect(result.map((issue) => issue.id)).toEqual(["1"]);
    });

    it("view=allはすべてのIssueを返す", () => {
      const issues = [makeIssue({ id: "1" }), makeIssue({ id: "2" })];
      expect(filterIssuesByView(issues, "all", null)).toHaveLength(2);
    });
  });

  describe("computeNavCounts", () => {
    it("各ビューに一致するIssue数を返す", () => {
      const issues = [
        makeIssue({
          id: "1",
          assignee: { login: "me" },
          author: { login: "me" },
          favorite: true,
          updatedAt: "2026-01-09T00:00:00.000Z",
        }),
        makeIssue({
          id: "2",
          assignee: { login: "other" },
          author: { login: "other" },
          favorite: false,
          updatedAt: "2025-01-01T00:00:00.000Z",
        }),
      ];
      expect(computeNavCounts(issues, "me")).toEqual({
        all: 2,
        assigned: 1,
        created: 1,
        favorites: 1,
        recent: 1,
      });
    });
  });

  describe("computeOverviewStats", () => {
    it("オープン件数・担当中件数・24時間以内更新件数を返す", () => {
      const issues = [
        makeIssue({
          id: "1",
          state: "open",
          assignee: { login: "me" },
          updatedAt: "2026-01-09T12:00:00.000Z",
        }),
        makeIssue({ id: "2", state: "open", assignee: null, updatedAt: "2026-01-01T00:00:00.000Z" }),
        makeIssue({ id: "3", state: "closed", assignee: { login: "me" } }),
      ];
      const stats = computeOverviewStats(issues, "me");
      expect(stats).toEqual([
        { label: "オープンIssue", value: "2", diffLabel: "" },
        { label: "担当中", value: "1", diffLabel: "" },
        { label: "24時間以内の更新", value: "1件", diffLabel: "" },
      ]);
    });
  });
});
