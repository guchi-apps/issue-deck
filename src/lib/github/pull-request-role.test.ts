import { describe, expect, it } from "vitest";

import { parsePullRequestRole } from "@/lib/github/pull-request-role";

describe("parsePullRequestRole", () => {
  it("closingマーカーを読み取る", () => {
    expect(
      parsePullRequestRole(
        "- Issueを閉じるPRか、途中PRか: このIssueを完了させる最終PRです。<!-- issue-deck-pr-role:closing -->",
      ),
    ).toBe("closing");
  });

  it("interimマーカーを読み取る", () => {
    expect(
      parsePullRequestRole(
        "- Issueを閉じるPRか、途中PRか: 後続PRが必要な途中PRです。<!-- issue-deck-pr-role:interim -->",
      ),
    ).toBe("interim");
  });

  it("マーカーが無ければnull", () => {
    expect(parsePullRequestRole("- 対応Issue: #1\n- 実装内容: ...")).toBeNull();
  });

  it("本文が無ければnull", () => {
    expect(parsePullRequestRole(null)).toBeNull();
    expect(parsePullRequestRole(undefined)).toBeNull();
    expect(parsePullRequestRole("")).toBeNull();
  });

  it("未知の値は読み取らない（正規表現の許容値に無いため素通りする）", () => {
    expect(parsePullRequestRole("<!-- issue-deck-pr-role:unknown -->")).toBeNull();
  });
});
