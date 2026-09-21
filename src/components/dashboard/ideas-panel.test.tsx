/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IdeasPanel } from "@/components/dashboard/ideas-panel";

const remove = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/hooks/use-ideas", () => ({
  useIdeas: () => ({
    ideas: [{
      name: "shopping",
      path: "ideas/shopping/README.md",
      title: "買い物メモ",
      state: "検討中",
      summary: "家族で共有するメモです。",
      markdown: "# 買い物メモ",
    }],
    isLoading: false,
    deletingPath: null,
    error: null,
    refresh: vi.fn(),
    remove,
  }),
}));
vi.mock("@/components/dashboard/markdown-body", () => ({
  MarkdownBody: ({ content }: { content: string }) => <div>{content}</div>,
}));

describe("IdeasPanel", () => {
  it("一覧から内容を開き、確認後に削除する", async () => {
    render(<IdeasPanel />);
    expect(screen.getByText("買い物メモ")).toBeTruthy();
    fireEvent.click(screen.getByText("内容を見る"));
    expect(screen.getByText("# 買い物メモ")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(screen.getByText("「買い物メモ」を削除しますか？")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    expect(remove).toHaveBeenCalledWith("ideas/shopping/README.md");
  });
});
