import { describe, expect, it } from "vitest";

import {
  buildFixIssueAutoClosedComment,
  decideFixIssueClose,
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

describe("buildFixIssueAutoClosedComment", () => {
  it("対象PR番号と、開け直せば閉じ直さないことを書き、巡回の発信元マーカーで終わる", () => {
    const body = buildFixIssueAutoClosedComment(123);
    expect(body).toContain("対象PR #123");
    expect(body).toContain("開き直したものは自動では閉じません");
    expect(body.trimEnd().endsWith("<!-- issue-deck-source:progress-sweep -->")).toBe(true);
  });
});
