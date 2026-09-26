import { describe, expect, it } from "vitest";

import { isPlanReviewPending } from "@/lib/github/plan-review";

const c = (body: string) => ({ body, author: { login: "u" } }) as never;

describe("isPlanReviewPending", () => {
  it("計画の後にレビューが届いていれば true", () => {
    expect(isPlanReviewPending([c("<!-- issue-deck:session-plan -->"), c("<!-- supervisor:plan-review -->")])).toBe(true);
  });
  it("レビューが無ければ false", () => {
    expect(isPlanReviewPending([c("<!-- issue-deck:session-plan -->")])).toBe(false);
  });
  it("応答済みなら false", () => {
    expect(
      isPlanReviewPending([
        c("<!-- issue-deck:session-plan -->"),
        c("<!-- supervisor:plan-review -->"),
        c("<!-- issue-deck-agent:plan-reviser -->"),
      ]),
    ).toBe(false);
  });
  it("レビューの後に計画が出し直されていれば false", () => {
    expect(
      isPlanReviewPending([c("<!-- supervisor:plan-review -->"), c("<!-- issue-deck:session-plan -->")]),
    ).toBe(false);
  });
});
