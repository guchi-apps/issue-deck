import { describe, expect, it } from "vitest";

import { decideReadyForReview, readyForReviewErrorMessage } from "@/lib/pull-request-ready-for-review";

const OPEN_DRAFT = { state: "open", merged: false, draft: true, headSha: "abc" };

describe("decideReadyForReview", () => {
  it("openかつdraftでheadが一致すればmark", () => {
    expect(decideReadyForReview(OPEN_DRAFT, "abc")).toEqual({ action: "mark" });
  });
  it("既にレビュー可能ならmutationを重ねない", () => {
    expect(decideReadyForReview({ ...OPEN_DRAFT, draft: false }, "abc")).toEqual({ action: "already_ready" });
  });
  it("closed・mergedは拒否する", () => {
    expect(decideReadyForReview({ ...OPEN_DRAFT, state: "closed" }, "abc")).toEqual({
      action: "reject",
      code: "pull_request_not_open",
    });
    expect(decideReadyForReview({ ...OPEN_DRAFT, state: "closed", merged: true }, "abc")).toEqual({
      action: "reject",
      code: "pull_request_not_open",
    });
  });
  it("headが変わっていれば拒否する（レビュー可能済みでも同じ）", () => {
    expect(decideReadyForReview(OPEN_DRAFT, "old")).toEqual({ action: "reject", code: "head_changed" });
    expect(decideReadyForReview({ ...OPEN_DRAFT, draft: false }, "old")).toEqual({
      action: "reject",
      code: "head_changed",
    });
  });
});

describe("readyForReviewErrorMessage", () => {
  it("コードごとに再試行方法つきの日本語を返し、未知のコードも成功扱いにしない", () => {
    expect(readyForReviewErrorMessage("permission_denied")).toContain("権限");
    expect(readyForReviewErrorMessage("head_changed")).toContain("更新");
    expect(readyForReviewErrorMessage(undefined)).toContain("失敗");
  });
});
