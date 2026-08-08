import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyIssueFilters,
  computeLabelSummary,
  computeNavCounts,
  computeOverviewStats,
  countCheckUserIssues,
  filterIssuesByView,
  getAssigneeOptions,
  reconcileIssues,
  sortIssues,
} from "@/lib/issue-stats";
import type { IssueFilters } from "@/hooks/use-issue-filters";
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
    closedAt: null,
    checkUserLabeledAt: null,
    lastCommentAt: null,
    htmlUrl: "https://github.com/owner/repo/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    deployCheckStatus: null,
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

    it("ラベルベースのビューは該当ラベルを持つIssueのみ返す", () => {
      const issues = [
        makeIssue({ id: "1", labels: [{ name: "00.check-user", color: "red", description: null }] }),
        makeIssue({ id: "2", labels: [{ name: "02.wip", color: "blue", description: null }] }),
        makeIssue({ id: "3", labels: [{ name: "03.d:marge", color: "blue", description: null }] }),
        makeIssue({ id: "4", labels: [{ name: "07.m:marge", color: "blue", description: null }] }),
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

    it("view=not-startedは実装状況ラベル・00.check-userのいずれも持たないIssueのみ返す", () => {
      const issues = [
        makeIssue({ id: "1", labels: [] }),
        makeIssue({ id: "2", labels: [{ name: "00.check-user", color: "red", description: null }] }),
        makeIssue({ id: "3", labels: [{ name: "02.wip", color: "blue", description: null }] }),
        makeIssue({ id: "4", labels: [{ name: "09.main", color: "green", description: null }] }),
        makeIssue({
          id: "5",
          labels: [{ name: "51.improvement", color: "purple", description: null }],
        }),
      ];
      expect(filterIssuesByView(issues, "not-started", null).map((issue) => issue.id)).toEqual([
        "1",
        "5",
      ]);
    });

    it("view=recently-mergedはリポジトリごとに最新リリース分のみ返す", () => {
      const mainLabel = { name: "09.main", color: "green", description: null };
      const issues = [
        // owner/repo-a の最新リリース（同一workflow run内で連続close）
        makeIssue({
          id: "1",
          repositoryFullName: "owner/repo-a",
          state: "closed",
          labels: [mainLabel],
          closedAt: "2026-01-09T10:00:00.000Z",
        }),
        makeIssue({
          id: "2",
          repositoryFullName: "owner/repo-a",
          state: "closed",
          labels: [mainLabel],
          closedAt: "2026-01-09T10:00:20.000Z",
        }),
        // owner/repo-a の1つ前のリリース
        makeIssue({
          id: "3",
          repositoryFullName: "owner/repo-a",
          state: "closed",
          labels: [mainLabel],
          closedAt: "2026-01-05T10:00:00.000Z",
        }),
        // 別リポジトリは別リリースとして扱う
        makeIssue({
          id: "4",
          repositoryFullName: "owner/repo-b",
          state: "closed",
          labels: [mainLabel],
          closedAt: "2026-01-02T10:00:00.000Z",
        }),
        // 09.mainがないclose済みIssueは対象外
        makeIssue({ id: "5", state: "closed", closedAt: "2026-01-09T10:00:10.000Z" }),
      ];
      expect(filterIssuesByView(issues, "recently-merged", null).map((issue) => issue.id)).toEqual([
        "1",
        "2",
        "4",
      ]);
    });

    it("view=recently-mergedの基準時刻は絞り込み前の集合から求める", () => {
      const mainLabel = { name: "09.main", color: "green", description: null };
      const latest = makeIssue({
        id: "1",
        state: "closed",
        labels: [mainLabel],
        closedAt: "2026-01-09T10:00:00.000Z",
      });
      const previous = makeIssue({
        id: "2",
        state: "closed",
        labels: [mainLabel],
        closedAt: "2026-01-05T10:00:00.000Z",
      });
      // 検索などで最新リリース分が絞り込まれて消えても、古いリリース分は現れない
      expect(
        filterIssuesByView([previous], "recently-merged", null, [latest, previous]),
      ).toEqual([]);
    });
  });

  describe("computeNavCounts", () => {
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
      expect(computeNavCounts(issues, issues, "me")).toEqual({
        all: 2,
        favorites: 1,
        "recently-added": 1,
        "check-user": 1,
        "not-started": 1,
        "in-progress": 0,
        "release-pending": 0,
        "recently-merged": 0,
      });
    });

    it("close済みIssueが対象のビューはissuesIgnoringStateを基準に数える", () => {
      const openIssues = [makeIssue({ id: "1" })];
      const allIssues = [
        ...openIssues,
        makeIssue({
          id: "2",
          state: "closed",
          labels: [{ name: "09.main", color: "green", description: null }],
          closedAt: "2026-01-09T10:00:00.000Z",
        }),
      ];
      const counts = computeNavCounts(openIssues, allIssues, null);
      expect(counts.all).toBe(1);
      expect(counts["recently-merged"]).toBe(1);
    });
  });

  describe("computeOverviewStats", () => {
    it("確認待ち件数・24時間以内の本番反映件数・オープンIssue件数を返す", () => {
      const mainLabel = { name: "09.main", color: "green", description: null };
      const checkUserLabel = { name: "00.check-user", color: "red", description: null };
      const issues = [
        makeIssue({ id: "1", state: "open", labels: [checkUserLabel] }),
        makeIssue({ id: "2", state: "open", labels: [] }),
        makeIssue({
          id: "3",
          state: "closed",
          labels: [mainLabel],
          closedAt: "2026-01-09T12:00:00.000Z",
        }),
        // 24時間より前にcloseされた分は「24時間以内の本番反映」から除外
        makeIssue({
          id: "4",
          state: "closed",
          labels: [mainLabel],
          closedAt: "2026-01-08T00:00:00.000Z",
        }),
        // 09.mainラベルが無いclose済みIssueは「24時間以内の本番反映」から除外
        makeIssue({
          id: "5",
          state: "closed",
          labels: [],
          closedAt: "2026-01-09T12:00:00.000Z",
        }),
      ];
      const issuesIgnoringState = issues;
      const stats = computeOverviewStats(issues, issuesIgnoringState);
      expect(stats).toEqual([
        { label: "確認待ち", value: "1", diffLabel: "", linkedView: "check-user" },
        { label: "24時間以内の本番反映", value: "1件", diffLabel: "" },
        { label: "オープンIssue", value: "2", diffLabel: "" },
      ]);
    });

    it("オープンIssue件数はissuesIgnoringStateを基準に数える（TopBarのstate絞り込みを無視する）", () => {
      const openIssues = [makeIssue({ id: "1", state: "open" })];
      const allIssues = [...openIssues, makeIssue({ id: "2", state: "closed" })];
      const stats = computeOverviewStats(openIssues, allIssues);
      expect(stats.find((stat) => stat.label === "オープンIssue")).toEqual({
        label: "オープンIssue",
        value: "1",
        diffLabel: "",
      });
    });
  });

  describe("countCheckUserIssues", () => {
    it("open状態かつ00.check-userラベル付きのIssueだけを数える", () => {
      const checkUserLabel = { name: "00.check-user", color: "red", description: null };
      const issues = [
        makeIssue({ id: "1", state: "open", labels: [checkUserLabel] }),
        makeIssue({ id: "2", state: "open", labels: [] }),
        // closed状態は運用上付かない想定だが、念のため除外する
        makeIssue({ id: "3", state: "closed", labels: [checkUserLabel] }),
      ];
      expect(countCheckUserIssues(issues)).toBe(1);
    });
  });
});
