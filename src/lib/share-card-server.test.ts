import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ issue: vi.fn(), repo: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db", () => ({
  db: { issue: { findUnique: mocks.issue }, repository: { findFirst: mocks.repo } },
}));
import { loadIssueShareCard, loadPullRequestShareCard } from "./share-card-server";

beforeEach(() => vi.clearAllMocks());

describe("loadIssueShareCard", () => {
  it("リポジトリ名と番号だけを返し、DBからもその3項目しか読まない", async () => {
    mocks.issue.mockResolvedValue({ number: 1366, repository: { fullName: "guchi-apps/yoteiflow" } });
    expect(await loadIssueShareCard("6022306920")).toEqual({
      kind: "issue",
      repositoryFullName: "guchi-apps/yoteiflow",
      number: 1366,
    });
    expect(mocks.issue.mock.calls[0][0].select).toEqual({ number: true, repository: { select: { fullName: true } } });
  });
  it("不正ID・未存在・DBエラーはnull", async () => {
    expect(await loadIssueShareCard("abc")).toBeNull();
    expect(mocks.issue).not.toHaveBeenCalled();
    mocks.issue.mockResolvedValue(null);
    expect(await loadIssueShareCard("1")).toBeNull();
    mocks.issue.mockRejectedValue(new Error("db"));
    expect(await loadIssueShareCard("2")).toBeNull();
  });
});

describe("loadPullRequestShareCard", () => {
  it("登録済みリポジトリだけ解決する", async () => {
    mocks.repo.mockResolvedValue({ fullName: "guchi-apps/issue-deck" });
    expect(await loadPullRequestShareCard("guchi-apps", "issue-deck", "5036")).toEqual({
      kind: "pr",
      repositoryFullName: "guchi-apps/issue-deck",
      number: 5036,
    });
    mocks.repo.mockResolvedValue(null);
    expect(await loadPullRequestShareCard("x", "y", "1")).toBeNull();
  });
  it("不正な値はDBを引かずnull", async () => {
    expect(await loadPullRequestShareCard("a/b", "c", "1")).toBeNull();
    expect(await loadPullRequestShareCard("a", "c", "0")).toBeNull();
    expect(mocks.repo).not.toHaveBeenCalled();
  });
});
