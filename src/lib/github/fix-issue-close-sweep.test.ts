import { describe, expect, it } from "vitest";

import {
  buildFixIssueAutoClosedComment,
  buildOriginalPullRequestAutoClosedComment,
  decideFixIssueClose,
  decideOriginalPullRequestClose,
} from "@/lib/github/fix-issue-close-sweep";

describe("decideFixIssueClose", () => {
  it("対象PRがマージされていれば閉じる", () => {
    const decision = decideFixIssueClose({ pullRequest: { merged: true, state: "closed" } });
    expect(decision).toEqual({ action: "close" });
  });

  it("対象PRがまだopenなら閉じない", () => {
    const decision = decideFixIssueClose({ pullRequest: { merged: false, state: "open" } });
    expect(decision).toEqual({ action: "skip", reason: "pr_open" });
  });

  it("対象PRがマージされずにクローズされていれば閉じない（別PRへの置き換えの可能性があるため）", () => {
    const decision = decideFixIssueClose({ pullRequest: { merged: false, state: "closed" } });
    expect(decision).toEqual({ action: "skip", reason: "pr_not_merged" });
  });
});

describe("decideOriginalPullRequestClose", () => {
  it("openな元PRを取り込んだ後続PRだけ閉じる", () => {
    expect(
      decideOriginalPullRequestClose({
        originalPullRequestOpen: true,
        replacementPullRequestFound: true,
        replacementBehindBy: 0,
      }),
    ).toEqual({ action: "close" });
  });

  it("元PRがopenでない・後続PRが無い・祖先関係を確認できない場合は閉じない", () => {
    expect(
      decideOriginalPullRequestClose({
        originalPullRequestOpen: false,
        replacementPullRequestFound: true,
        replacementBehindBy: 0,
      }),
    ).toEqual({ action: "skip", reason: "original_pr_not_open" });
    expect(
      decideOriginalPullRequestClose({
        originalPullRequestOpen: true,
        replacementPullRequestFound: false,
        replacementBehindBy: null,
      }),
    ).toEqual({ action: "skip", reason: "replacement_pr_not_found" });
    expect(
      decideOriginalPullRequestClose({
        originalPullRequestOpen: true,
        replacementPullRequestFound: true,
        replacementBehindBy: 1,
      }),
    ).toEqual({ action: "skip", reason: "original_pr_not_in_replacement" });
  });
});

describe("buildFixIssueAutoClosedComment", () => {
  it("対象PR番号と、開け直せば閉じ直さないことを書き、巡回の発信元マーカーで終わる", () => {
    const body = buildFixIssueAutoClosedComment(123);
    expect(body).toContain("対象PR #123");
    expect(body).toContain("開き直したものは自動では閉じません");
    expect(body.trimEnd().endsWith("<!-- issue-deck-source:progress-sweep -->")).toBe(true);
  });
});

describe("buildOriginalPullRequestAutoClosedComment", () => {
  it("置き換え先の修正PRを示し、巡回の発信元マーカーで終わる", () => {
    const body = buildOriginalPullRequestAutoClosedComment(456);
    expect(body).toContain("修正PR #456");
    expect(body.trimEnd().endsWith("<!-- issue-deck-source:progress-sweep -->")).toBe(true);
  });
});
