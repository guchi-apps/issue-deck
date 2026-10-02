// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PlanReviewFindings, buildNextSteps } from "@/components/dashboard/plan-review-findings";
import { parsePlanReview } from "@/lib/github/plan-review";

afterEach(cleanup);

const BODY = [
  "## 計画レビュー",
  "",
  "**1. 指摘の題**",
  "- **指摘**: 直す点",
  "",
  "推奨: 修正のうえ承認（理由の本文）",
].join("\n");

function renderCard(extra: Partial<Parameters<typeof PlanReviewFindings>[0]> = {}) {
  const review = parsePlanReview(BODY);
  return render(
    <PlanReviewFindings
      review={review}
      submitLabel="選んだ指摘で計画を出し直す"
      fallbackSubmitLabel="レビューを反映して計画を出し直す"
      approveHint="下の「承認して実装へ進む」を押す"
      onSubmit={() => {}}
      {...extra}
    />,
  );
}

describe("PlanReviewFindings の操作帯", () => {
  it("指摘だけのときは、反映／見送りを選んで出し直しを押す手順を出す", () => {
    renderCard();
    expect(screen.getByText("あなたの操作が必要です")).toBeTruthy();
    expect(screen.getByText(/「選んだ指摘で計画を出し直す」を押す/)).toBeTruthy();
  });

  it("推奨の理由は既定で隠れ、開閉ボタンで開く", () => {
    renderCard();
    expect(screen.queryByText("理由の本文")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /推奨の理由とレビュー要約/ }));
    expect(screen.getByText("理由の本文")).toBeTruthy();
  });

  it("届かない理由があるときは手順の代わりに案内を出す", () => {
    renderCard({ unavailable: "expired" });
    expect(screen.getByText("いまはここから送れません")).toBeTruthy();
    expect(screen.getByText(/端末かRemote Controlで答えてください/)).toBeTruthy();
    expect(screen.queryByText("あなたの操作が必要です")).toBeNull();
  });
});

describe("buildNextSteps", () => {
  const base = {
    hasFindings: true,
    noFindings: false,
    undecidedCount: 0,
    decisionCount: 0,
    applyCount: 1,
    approveRecommended: false,
    submitLabel: "出し直す",
    fallbackSubmitLabel: "一括で出し直す",
    approveHint: "承認を押す",
  };

  it("判断が残っている間は、判断を選ぶ手順が先に来る", () => {
    const steps = buildNextSteps({ ...base, undecidedCount: 2, decisionCount: 2 });
    expect(steps[0].text).toContain("判断2件");
    expect(steps).toHaveLength(2);
  });

  it("判断を選び終えたら1つ目を済みにする", () => {
    const steps = buildNextSteps({ ...base, decisionCount: 1 });
    expect(steps[0].done).toBe(true);
  });

  it("推奨が承認のときは承認だけを案内する", () => {
    expect(buildNextSteps({ ...base, approveRecommended: true })).toEqual([
      { text: "操作は承認だけです。承認を押す" },
    ]);
  });

  it("指摘なし・本文のみの場合も承認先を出す", () => {
    expect(buildNextSteps({ ...base, hasFindings: false, noFindings: true })[0].text).toContain("承認を押す");
    expect(buildNextSteps({ ...base, hasFindings: false })[0].text).toContain("一括で出し直す");
  });
});
