// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CommentAiSummary } from "@/components/dashboard/comment-ai-summary";

function renderSummary(summary: string | null) {
  return render(
    <CommentAiSummary
      summary={summary}
      isGenerating={false}
      error={null}
      notConfigured={false}
      onGenerate={() => {}}
    />,
  );
}

describe("CommentAiSummary", () => {
  afterEach(() => {
    cleanup();
  });

  it("要約をMarkdownとしてレンダリングする", () => {
    const { container } = renderSummary("## 重要な点\n\n- **太字**の項目\n- 通常の項目");

    const heading = screen.getByText("重要な点");
    expect(heading.tagName).toBe("H3");
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("太字").tagName).toBe("STRONG");
  });

  it("Markdown記法を生の文字列として表示しない", () => {
    renderSummary("## 懸念点\n\n特になし");

    expect(screen.queryByText(/## 懸念点/)).toBeNull();
  });

  it("要約が未生成のときは生成ボタンを表示する", () => {
    renderSummary(null);

    expect(screen.getByRole("button", { name: "要約を生成" })).not.toBeNull();
  });
});
