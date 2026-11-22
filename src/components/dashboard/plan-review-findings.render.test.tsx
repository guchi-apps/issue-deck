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

describe("指摘カードの要約と詳細（#5579）", () => {
  const LONG = "長い指摘の文章。".repeat(20);
  const DETAIL_BODY = [
    "## 計画レビュー",
    "",
    "**1. 指摘の題**",
    `- **指摘**: ${LONG}`,
    "- **提案**: こう直す",
    "- **根拠**: 実物のファイルを確認した",
    "",
    "推奨: 修正のうえ承認",
  ].join("\n");

  it("閉じている間は要約だけを出し、開くと指摘・提案・根拠を出す", () => {
    render(
      <PlanReviewFindings
        review={parsePlanReview(DETAIL_BODY)}
        submitLabel="選んだ指摘で計画を出し直す"
        fallbackSubmitLabel="一括"
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByTestId("finding-summary-1").textContent).toContain("こう直す");
    expect(screen.queryByText("実物のファイルを確認した")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /詳細を開く/ }));
    expect(screen.queryByTestId("finding-summary-1")).toBeNull();
    expect(screen.getByText("実物のファイルを確認した")).toBeTruthy();
    expect(screen.getByText("指摘")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /詳細を閉じる/ }));
    expect(screen.getByTestId("finding-summary-1")).toBeTruthy();
  });

  it("短く根拠も無い指摘には詳細ボタンを出さない", () => {
    renderCard();
    expect(screen.getByTestId("finding-summary-1").textContent).toBe("直す点");
    expect(screen.queryByRole("button", { name: /詳細を開く/ })).toBeNull();
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

describe("PlanReviewFindings の追記欄（#3829）", () => {
  it("追記を書くと、選択結果の依頼文の末尾に連結して送る", () => {
    const sent: string[] = [];
    renderCard({ onSubmit: (text) => void sent.push(text) });
    fireEvent.change(screen.getByLabelText("追加で修正したいこと（任意）"), {
      target: { value: "見出しも直してほしい" },
    });
    fireEvent.click(screen.getByRole("button", { name: /選んだ指摘で計画を出し直す/ }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("反映する:");
    expect(sent[0].endsWith("見出しも直してほしい")).toBe(true);
  });

  it("全件見送りでも、追記があれば送れる", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /見送る/ }));
    const submit = screen.getByRole("button", { name: /選んだ指摘で計画を出し直す/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("追加で修正したいこと（任意）"), { target: { value: "別の直し" } });
    expect(submit.disabled).toBe(false);
  });
});

describe("補足だけで承認が推奨のカード（#3850）", () => {
  const NOTE_BODY = [
    "## 計画レビュー",
    "",
    "**1. 文言テストの更新**",
    "- **区分**: 実装時対応の補足",
    "- **指摘**: 文言も合わせる",
    "",
    "推奨: このまま承認してよい",
  ].join("\n");

  it("反映する・見送る・追記欄・出し直しを出さず、承認だけを案内する", () => {
    render(
      <PlanReviewFindings
        review={parsePlanReview(NOTE_BODY)}
        submitLabel="選んだ指摘で計画を出し直す"
        fallbackSubmitLabel="レビューを反映して計画を出し直す"
        deemphasizeSubmit
        approveHint="下の「計画を承認する」を押す"
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText("文言テストの更新")).toBeTruthy();
    expect(screen.queryByText("反映する")).toBeNull();
    expect(screen.queryByText("見送る")).toBeNull();
    expect(screen.queryByText("追加で修正したいこと（任意）")).toBeNull();
    expect(screen.queryByRole("button", { name: /出し直す/ })).toBeNull();
    expect(screen.getByText(/操作は承認だけです。下の「計画を承認する」を押す/)).toBeTruthy();
  });
});
