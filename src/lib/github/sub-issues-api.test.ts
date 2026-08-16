import { beforeEach, describe, expect, it, vi } from "vitest";

const githubGraphql = vi.fn();

vi.mock("@/lib/github/graphql", () => ({
  get githubGraphql() {
    return githubGraphql;
  },
}));

import { fetchSubIssueRelations } from "@/lib/github/sub-issues-api";

describe("fetchSubIssueRelations", () => {
  beforeEach(() => {
    githubGraphql.mockReset();
  });

  it("親子が置かれているリポジトリを一緒に返す（#1722）", async () => {
    githubGraphql.mockResolvedValue({
      repository: {
        issue: {
          parent: {
            number: 1698,
            title: "親",
            state: "OPEN",
            url: "https://github.com/guchi-apps/issue-deck/issues/1698",
            repository: { nameWithOwner: "guchi-apps/issue-deck" },
          },
          subIssues: {
            totalCount: 1,
            nodes: [
              {
                number: 12,
                title: "car-careへの横展開",
                state: "CLOSED",
                url: "https://github.com/guchi-apps/car-care/issues/12",
                repository: { nameWithOwner: "guchi-apps/car-care" },
              },
            ],
          },
        },
      },
    });

    const relations = await fetchSubIssueRelations("token", "guchi-apps", "issue-deck", 1722);

    expect(relations.parent).toEqual({
      number: 1698,
      title: "親",
      state: "open",
      htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1698",
      repositoryFullName: "guchi-apps/issue-deck",
    });
    expect(relations.children[0].repositoryFullName).toBe("guchi-apps/car-care");
    expect(relations.children[0].state).toBe("closed");
    expect(relations.childCount).toBe(1);
  });

  it("リポジトリが返らなかった場合は問い合わせ元のリポジトリへ倒す", async () => {
    // 空文字のまま流すと、進捗のDB引き当てが黙って外れる
    githubGraphql.mockResolvedValue({
      repository: {
        issue: {
          parent: null,
          subIssues: {
            totalCount: 1,
            nodes: [
              {
                number: 1177,
                title: "子",
                state: "OPEN",
                url: "https://github.com/guchi-apps/issue-deck/issues/1177",
                repository: null,
              },
            ],
          },
        },
      },
    });

    const relations = await fetchSubIssueRelations("token", "guchi-apps", "issue-deck", 1722);
    expect(relations.children[0].repositoryFullName).toBe("guchi-apps/issue-deck");
  });

  it("Issueが見つからなければ関係なしを返す", async () => {
    githubGraphql.mockResolvedValue({ repository: { issue: null } });
    const relations = await fetchSubIssueRelations("token", "guchi-apps", "issue-deck", 1);
    expect(relations).toEqual({ parent: null, children: [], childCount: 0 });
  });
});
