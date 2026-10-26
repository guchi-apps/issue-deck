import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ issue: vi.fn(), repo: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db", () => ({
  db: { issue: { findUnique: mocks.issue }, repository: { findFirst: mocks.repo } },
}));
import { loadIssueShareCard, loadPullRequestShareCard } from "./share-card-server";

beforeEach(() => vi.clearAllMocks());

describe("loadIssueShareCard", () => {
  it("リポジトリ名・番号・タイトル・GitHub上の作成日時だけを返し、本文などはDBから読まない", async () => {
    const createdAt = new Date("2026-10-25T16:30:00Z");
    mocks.issue.mockResolvedValue({
      number: 1366,
      title: "予定の重複を検出する",
      githubCreatedAt: createdAt,
      repository: { fullName: "guchi-apps/yoteiflow", private: false },
    });
    expect(await loadIssueShareCard("6022306920")).toEqual({
      kind: "issue",
      repositoryFullName: "guchi-apps/yoteiflow",
      number: 1366,
      title: "予定の重複を検出する",
      createdAt,
    });
    expect(mocks.issue.mock.calls[0][0].select).toEqual({
      number: true,
      title: true,
      githubCreatedAt: true,
      repository: { select: { fullName: true, private: true } },
    });
  });
  it("非公開リポジトリのIssueはnull", async () => {
    mocks.issue.mockResolvedValue({
      number: 1,
      title: "秘密",
      githubCreatedAt: new Date(),
      repository: { fullName: "o/secret", private: true },
    });
    expect(await loadIssueShareCard("1")).toBeNull();
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
    expect(mocks.repo.mock.calls[0][0].where).toEqual({ fullName: "guchi-apps/issue-deck", private: false });
    mocks.repo.mockResolvedValue(null);
    expect(await loadPullRequestShareCard("x", "y", "1")).toBeNull();
  });
  it("不正な値はDBを引かずnull", async () => {
    expect(await loadPullRequestShareCard("a/b", "c", "1")).toBeNull();
    expect(await loadPullRequestShareCard("a", "c", "0")).toBeNull();
    expect(mocks.repo).not.toHaveBeenCalled();
  });
});
