import { describe, expect, it } from "vitest";
import {
  buildPullRequestFixIssueDraft,
  RELEASE_FIX_ISSUE_OBSERVATION_HEADING,
  showsPullRequestFixIssueButton,
} from "@/lib/github/pull-request-release-fix-issue";

describe("showsPullRequestFixIssueButton", () => {
  it("マージ済みの通常PRだけ対象にする", () => {
    expect(showsPullRequestFixIssueButton({ merged: true, kind: "issue" } as never)).toBe(true);
    expect(showsPullRequestFixIssueButton({ merged: false, kind: "issue" } as never)).toBe(false);
    expect(showsPullRequestFixIssueButton({ merged: true, kind: "release" } as never)).toBe(false);
  });
});

describe("buildPullRequestFixIssueDraft", () => {
  const base = {
    repositoryFullName: "guchi-apps/example",
    number: 12,
    title: "一覧を直す",
    mergedAt: "2026-10-01T00:00:00Z",
    linkedIssueNumber: 7,
  };

  it("対象PR・元Issue・確認内容の欄を入れる", () => {
    const draft = buildPullRequestFixIssueDraft(base);
    expect(draft.repositoryFullName).toBe("guchi-apps/example");
    expect(draft.title).toBe("#12 の修正: 一覧を直す");
    expect(draft.bodyPrefix).toContain("- 対象PR: #12 一覧を直す");
    expect(draft.bodyPrefix).toContain("- 元Issue: #7");
    expect(draft.bodyPrefix).toContain(RELEASE_FIX_ISSUE_OBSERVATION_HEADING);
    // 前半は編集不可の接頭辞に入り、入力欄は空で始まる
    expect(draft.body).toBe("");
  });

  it("元Issueやマージ日時が無ければその行を出さない", () => {
    const draft = buildPullRequestFixIssueDraft({ ...base, mergedAt: null, linkedIssueNumber: null });
    expect(draft.bodyPrefix).not.toContain("元Issue");
    expect(draft.bodyPrefix).not.toContain("マージ日時");
  });
});
