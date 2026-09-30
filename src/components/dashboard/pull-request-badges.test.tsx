// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MergeJudgementBadge } from "@/components/dashboard/pull-request-badges";
import { AI_REVIEW_NONE, type MergeJudgement } from "@/lib/github/check-rollup";

afterEach(cleanup);

const waitForCi: MergeJudgement = {
  state: "pending",
  step: "wait-for-ci",
  runUrl: null,
  aiReview: AI_REVIEW_NONE,
};

describe("MergeJudgementBadge", () => {
  it("CIが実行中の間は「CIの完了待ち」を出さない（CI実行中と重なるため。#3662）", () => {
    render(<MergeJudgementBadge mergeJudgement={waitForCi} ciState="pending" />);
    expect(screen.queryByText("CIの完了待ち")).toBeNull();
  });

  it("CI状態を渡さない・pending以外なら従来どおり出す", () => {
    const { rerender } = render(<MergeJudgementBadge mergeJudgement={waitForCi} />);
    expect(screen.getByText("CIの完了待ち")).toBeTruthy();
    rerender(<MergeJudgementBadge mergeJudgement={waitForCi} ciState="unknown" />);
    expect(screen.getByText("CIの完了待ち")).toBeTruthy();
  });

  it("wait-for-ci以外の段階はCI実行中でも出す", () => {
    render(
      <MergeJudgementBadge mergeJudgement={{ ...waitForCi, step: "risk-check" }} ciState="pending" />,
    );
    expect(screen.getByText("マージ可否を判定中")).toBeTruthy();
  });
});
