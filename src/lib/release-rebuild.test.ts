import { describe, expect, it } from "vitest";

import {
  buildRebuildCandidate,
  canRebuildRelease,
  parseRebuildPullRequests,
  releaseRebuildCloseComment,
} from "@/lib/release-rebuild";

const commit = (message: string) => ({ commit: { message } });

describe("parseRebuildPullRequests", () => {
  it("マージコミットからPR番号・タイトル・対応Issueを取り出し、番号順に並べる", () => {
    expect(
      parseRebuildPullRequests([
        commit("Merge pull request #3022 from guchi-apps/issue-3020\n\n計画承認パネルの二重表示を直す"),
        commit("修正する"),
        commit("Merge pull request #3019 from guchi-apps/hotfix\n\nhotfixを当てる"),
      ]),
    ).toEqual([
      { number: 3019, title: "hotfixを当てる", issueNumber: null },
      { number: 3022, title: "計画承認パネルの二重表示を直す", issueNumber: 3020 },
    ]);
  });

  it("バンプPR・リリースPRのマージは「新たに入る変更」に数えない", () => {
    expect(
      parseRebuildPullRequests([
        commit("Merge pull request #3018 from guchi-apps/release/v6.4.0\n\nv6.4.0をリリースする"),
        commit("Merge pull request #3017 from guchi-apps/release-main/v6.3.0\n\nv6.3.0をmainへリリースする"),
      ]),
    ).toEqual([]);
  });

  it("本文にタイトルが無ければ件名で代える", () => {
    expect(parseRebuildPullRequests([commit("Merge pull request #5 from o/issue-4")])).toEqual([
      { number: 5, title: "Merge pull request #5 from o/issue-4", issueNumber: 4 },
    ]);
  });
});

describe("buildRebuildCandidate", () => {
  it("バンプPR自身のマージコミットだけなら、新しい変更は0件", () => {
    expect(
      buildRebuildCandidate([commit("Merge pull request #3018 from guchi-apps/release/v6.4.0\n\nv6.4.0をリリースする")]),
    ).toEqual({ aheadBy: 0, pullRequests: [] });
  });

  it("バンプ後に入った修正のコミットとマージを数える", () => {
    expect(
      buildRebuildCandidate([
        commit("Merge pull request #3018 from guchi-apps/release/v6.4.0\n\nv6.4.0をリリースする"),
        commit("直す"),
        commit("Merge pull request #3022 from guchi-apps/issue-3020\n\n直す"),
      ]),
    ).toEqual({ aheadBy: 2, pullRequests: [{ number: 3022, title: "直す", issueNumber: 3020 }] });
  });
});

describe("canRebuildRelease", () => {
  it("developに新しいコミットがあるときだけ作り直せる", () => {
    expect(canRebuildRelease({ aheadBy: 2, pullRequests: [] })).toBe(true);
    expect(canRebuildRelease({ aheadBy: 0, pullRequests: [] })).toBe(false);
    expect(canRebuildRelease(null)).toBe(false);
  });
});

describe("releaseRebuildCloseComment", () => {
  it("閉じた理由と新たに含まれる変更を残す", () => {
    const body = releaseRebuildCloseComment({
      aheadBy: 2,
      pullRequests: [{ number: 3022, title: "直す", issueNumber: 3020 }],
    });
    expect(body).toContain("修正を入れて作り直す");
    expect(body).toContain("- #3022 直す（Issue #3020）");
  });
});
