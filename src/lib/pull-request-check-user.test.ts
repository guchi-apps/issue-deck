import { beforeEach, describe, expect, it, vi } from "vitest";

const issueFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    issue: {
      get findMany() {
        return issueFindMany;
      },
    },
  },
}));

const { checkUserIssueKey, fetchCheckUserIssueKeys } = await import("@/lib/pull-request-check-user");

beforeEach(() => {
  issueFindMany.mockReset();
});

describe("fetchCheckUserIssueKeys", () => {
  it("調べる対象が無ければクエリを投げない", async () => {
    const keys = await fetchCheckUserIssueKeys([{ repositoryId: "repo-1", issueNumbers: [] }]);
    expect(keys.size).toBe(0);
    expect(issueFindMany).not.toHaveBeenCalled();
  });

  it("リポジトリごとのORで引き、00.check-userで絞る", async () => {
    issueFindMany.mockResolvedValue([]);
    await fetchCheckUserIssueKeys([
      // 同じ番号を複数のPRから渡されても、条件は一意にする
      { repositoryId: "repo-1", issueNumbers: [10, 10, 11] },
      { repositoryId: "repo-2", issueNumbers: [10] },
    ]);

    expect(issueFindMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { repositoryId: "repo-1", number: { in: [10, 11] } },
          { repositoryId: "repo-2", number: { in: [10] } },
        ],
        labels: { some: { name: "00.check-user" } },
      },
      select: { repositoryId: true, number: true },
    });
  });

  it("返ってきた行の(リポジトリ, 番号)の組だけを持つ（番号だけの一致では拾わない）", async () => {
    issueFindMany.mockResolvedValue([{ repositoryId: "repo-1", number: 10 }]);
    const keys = await fetchCheckUserIssueKeys([
      { repositoryId: "repo-1", issueNumbers: [10] },
      { repositoryId: "repo-2", issueNumbers: [10] },
    ]);

    expect(keys.has(checkUserIssueKey("repo-1", 10))).toBe(true);
    // 別リポジトリの同じ番号は、条件に含めていてもキーが違うので混ざらない
    expect(keys.has(checkUserIssueKey("repo-2", 10))).toBe(false);
  });
});
