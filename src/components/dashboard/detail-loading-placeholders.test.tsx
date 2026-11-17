// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DetailLoadingCard, resolveDetailLoading } from "./detail-loading-placeholders";

afterEach(cleanup);

const base = {
  labels: [{ name: "00.check-user" }, { name: "01.check-plan" }, { name: "25.artifact-required" }],
  dispatchLoaded: false,
  planRequestPresent: false,
  artifactsLoaded: false,
  commentsLoading: true,
  planReviewPresent: false,
};

describe("resolveDetailLoading（#5471）", () => {
  it("取得前は出るはずの3欄すべてを取得中にする", () => {
    expect(resolveDetailLoading(base)).toEqual({ plan: true, artifacts: true, planReview: true });
  });

  it("取得が終われば枠は消える", () => {
    expect(
      resolveDetailLoading({ ...base, dispatchLoaded: true, artifactsLoaded: true, commentsLoading: false }),
    ).toEqual({ plan: false, artifacts: false, planReview: false });
  });

  it("実物が見つかっていれば枠は出さない", () => {
    const state = resolveDetailLoading({ ...base, planRequestPresent: true, planReviewPresent: true });
    expect(state.plan).toBe(false);
    expect(state.planReview).toBe(false);
  });

  it("ラベルから出るはずと分からないIssueでは枠を出さない", () => {
    expect(resolveDetailLoading({ ...base, labels: [] })).toEqual({
      plan: false,
      artifacts: false,
      planReview: false,
    });
  });
});

describe("DetailLoadingCard", () => {
  it("取得中の文言をstatusとして出す", () => {
    render(<DetailLoadingCard label="計画レビューを取得中…" />);
    expect(screen.getByRole("status").textContent).toContain("計画レビューを取得中…");
  });
});

describe("IssueArtifactPanel の取得失敗（#5471）", () => {
  it("失敗時は未作成と区別した案内を出す", async () => {
    const { IssueArtifactPanel } = await import("./issue-artifact-panel");
    render(<IssueArtifactPanel artifacts={[]} isFailed onReload={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("取得できませんでした");
  });

  it("失敗でなければ従来どおり何も出さない", async () => {
    const { IssueArtifactPanel } = await import("./issue-artifact-panel");
    const { container } = render(<IssueArtifactPanel artifacts={[]} onReload={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
