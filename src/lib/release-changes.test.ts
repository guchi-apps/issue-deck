import { describe, expect, it } from "vitest";

import { toReleaseChanges } from "@/lib/release-changes";

function merge(sha: string, n: number, branch: string, title: string) {
  return { sha, message: `Merge pull request #${n} from guchi-apps/${branch}\n\n${title}` };
}

describe("toReleaseChanges", () => {
  it("PR単位に畳み、IssueなしPR・同一Issueの複数PRも別々に出す", () => {
    const { pullRequests, unknownCommits } = toReleaseChanges([
      { sha: "c0", message: "作業コミット" },
      merge("c1", 10, "issue-5", "最初のPR"),
      merge("c2", 11, "issue-5", "同じIssueの2つ目のPR"),
      merge("c3", 12, "hotfix-x", "Issueなしのブランチ"),
    ]);
    expect(pullRequests.map((pr) => [pr.number, pr.issueNumber])).toEqual([
      [12, null],
      [11, 5],
      [10, 5],
    ]);
    expect(unknownCommits).toEqual([]);
  });

  it("同じPR番号は重複させない", () => {
    const { pullRequests } = toReleaseChanges([
      merge("c1", 10, "issue-5", "PR"),
      { sha: "c2", message: "PR (#10)" },
      merge("c3", 11, "issue-6", "別のPR"),
    ]);
    expect(pullRequests.map((pr) => pr.number).sort()).toEqual([10, 11]);
  });

  it("squash運用でPR番号を特定できないコミットは対応不明として分ける", () => {
    const { pullRequests, unknownCommits } = toReleaseChanges([
      { sha: "s1", message: "直接コミット" },
      { sha: "s2", message: "機能追加 (#20)" },
    ]);
    expect(pullRequests.map((pr) => pr.number)).toEqual([20]);
    expect(unknownCommits).toEqual([{ sha: "s1", title: "直接コミット" }]);
  });

  it("バージョンバンプPRは印を付ける", () => {
    const { pullRequests } = toReleaseChanges([merge("b1", 30, "release/v1.2.3", "v1.2.3へ")]);
    expect(pullRequests[0].isVersionBump).toBe(true);
  });
});
