import { describe, expect, it } from "vitest";

import {
  CODE_REVIEW_REPORT_MARKER,
  CODE_REVIEW_REQUEST_MARKER,
  summarizeCodeReviewComments,
} from "@/lib/github/code-review";
import {
  buildCodeReviewAutoClosedComment,
  decideCompletedCodeReview,
  verifyCompletedCodeReview,
} from "@/lib/github/code-review-close-sweep";

const REPO = "guchi-apps/vps";

function report(...titles: string[]): string {
  return [
    CODE_REVIEW_REPORT_MARKER,
    "読んだコード: guchi-apps/vps origin/develop abc1234",
    "",
    ...titles.map((title) => `### [中] ${title}\n\n本文\n`),
  ].join("\n");
}

function issue(title: string, number: number, state: "open" | "closed") {
  return { repositoryFullName: REPO, title, number, state };
}

describe("decideCompletedCodeReview", () => {
  const summary = summarizeCodeReviewComments([{ body: report("指摘A", "指摘B") }]);

  it("全指摘が起票済みで全部closeされていれば閉じる（画面の`対応済み n/n`と同じ）", () => {
    const decision = decideCompletedCodeReview({
      summary,
      issues: [issue("指摘A", 10, "closed"), issue("指摘B", 11, "closed")],
      repositoryFullName: REPO,
    });
    expect(decision).toEqual({ action: "close", total: 2 });
  });

  it("まだopenな指摘のIssueがあれば閉じない", () => {
    const decision = decideCompletedCodeReview({
      summary,
      issues: [issue("指摘A", 10, "closed"), issue("指摘B", 11, "open")],
      repositoryFullName: REPO,
    });
    expect(decision).toEqual({ action: "skip", reason: "unresolved" });
  });

  it("未起票の指摘が1件でもあれば閉じない", () => {
    const decision = decideCompletedCodeReview({
      summary,
      issues: [issue("指摘A", 10, "closed")],
      repositoryFullName: REPO,
    });
    expect(decision).toEqual({ action: "skip", reason: "unresolved" });
  });

  it("別リポジトリの同名Issueは対応済みに数えない", () => {
    const decision = decideCompletedCodeReview({
      summary,
      issues: [
        issue("指摘A", 10, "closed"),
        { repositoryFullName: "guchi-apps/other", title: "指摘B", number: 1, state: "closed" },
      ],
      repositoryFullName: REPO,
    });
    expect(decision).toEqual({ action: "skip", reason: "unresolved" });
  });

  it("指摘が0件のレビューは閉じない", () => {
    const empty = summarizeCodeReviewComments([{ body: report() }]);
    expect(empty.state).toBe("reported");
    expect(
      decideCompletedCodeReview({ summary: empty, issues: [], repositoryFullName: REPO }),
    ).toEqual({ action: "skip", reason: "no_findings" });
  });

  it("結果がまだ返っていないレビューは閉じない", () => {
    const pending = summarizeCodeReviewComments([{ body: CODE_REVIEW_REQUEST_MARKER }]);
    expect(
      decideCompletedCodeReview({ summary: pending, issues: [], repositoryFullName: REPO }),
    ).toEqual({ action: "skip", reason: "not_reported" });
  });
});

describe("verifyCompletedCodeReview", () => {
  const titles = ["指摘A", "指摘B"];

  it("結果が最後のコメントで、指摘の並びも同じならok", () => {
    expect(
      verifyCompletedCodeReview({
        comments: [{ body: CODE_REVIEW_REQUEST_MARKER }, { body: report(...titles) }],
        findingTitles: titles,
      }),
    ).toBe("ok");
  });

  it("結果の後に再レビューの依頼が来ていたら閉じない", () => {
    expect(
      verifyCompletedCodeReview({
        comments: [{ body: report(...titles) }, { body: CODE_REVIEW_REQUEST_MARKER }],
        findingTitles: titles,
      }),
    ).toBe("review_rerun_pending");
  });

  it("判定に使った結果と指摘が変わっていたら閉じない", () => {
    expect(
      verifyCompletedCodeReview({
        comments: [{ body: report(...titles) }, { body: report("指摘A", "新しい指摘") }],
        findingTitles: titles,
      }),
    ).toBe("review_report_changed");
  });
});

describe("buildCodeReviewAutoClosedComment", () => {
  it("件数と、開け直せば閉じ直さないことを書き、巡回の発信元マーカーで終わる", () => {
    const body = buildCodeReviewAutoClosedComment(6);
    expect(body).toContain("指摘6件");
    expect(body).toContain("開き直したものは自動では閉じません");
    expect(body.trimEnd().endsWith("<!-- issue-deck-source:progress-sweep -->")).toBe(true);
  });
});
