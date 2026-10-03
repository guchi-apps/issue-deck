// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KnowledgeBoardPanel, PromotionKnowledgeList } from "@/components/dashboard/knowledge-board-panel";
import type { KnowledgeBoardData, PromotionKnowledgeFile } from "@/lib/knowledge-board";

function makeFiles(count: number): PromotionKnowledgeFile[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `knowledge/file-${i}.md`,
    items: [
      { kind: "added" as const, title: `追加の知見${i}`, summary: `結論${i}` },
      ...(i === 0
        ? [{ kind: "updated" as const, title: "更新された既存の知見", summary: "追記の結論" }]
        : []),
    ],
    additions: 5,
    deletions: 0,
  }));
}

describe("PromotionKnowledgeList", () => {
  afterEach(() => cleanup());

  it("変更が無ければ何も出さない", () => {
    const { container } = render(<PromotionKnowledgeList changes={[]} />);
    expect(container.childElementCount).toBe(0);
  });

  it("既定で開いており、件数の内訳・ファイル名・種別・見出し・結論を出す", () => {
    render(<PromotionKnowledgeList changes={makeFiles(2)} />);

    expect(screen.getByRole("button", { name: /マージされる知識/}).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText("3件（追加2・更新1）／2ファイル")).toBeTruthy();
    expect(screen.getByText("knowledge/file-0.md")).toBeTruthy();
    expect(screen.getByText("追加の知見1")).toBeTruthy();
    expect(screen.getByText("結論1")).toBeTruthy();
    expect(screen.getByText("更新")).toBeTruthy();
  });

  it("見出しを押すと畳める", () => {
    render(<PromotionKnowledgeList changes={makeFiles(1)} />);
    fireEvent.click(screen.getByRole("button", { name: /マージされる知識/ }));
    expect(screen.queryByText("追加の知見0")).toBeNull();
  });

  it("5ファイルを超えたぶんは「あとNファイル」で開く", () => {
    render(<PromotionKnowledgeList changes={makeFiles(7)} />);
    expect(screen.queryByText("knowledge/file-6.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "あと2ファイル（2件）を表示" }));
    expect(screen.getByText("knowledge/file-6.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "折りたたむ" })).toBeTruthy();
  });

  it("見出しで取り出せなかったファイルは、行数を出して落とさない", () => {
    render(
      <PromotionKnowledgeList
        changes={[{ path: "knowledge/foo.md", items: [], additions: 12, deletions: 1 }]}
      />,
    );
    expect(screen.getByText("knowledge/foo.md")).toBeTruthy();
    expect(screen.getByText(/見出しの単位では取り出せませんでした/)).toBeTruthy();
    expect(screen.getByText("+12 −1行")).toBeTruthy();
  });
});

function boardData(): KnowledgeBoardData {
  return {
    sections: [
      {
        path: "knowledge/github-actions.md",
        title: "全文を読める知識",
        summary: "カードには要約を表示します。",
        content: "- **結論**: カードを開くと詳細本文も読めます。\n\n詳細本文の続きです。",
        confirmedOn: "2026-10-01",
        source: "guchi-apps/issue-deck#3886",
        enteredAt: "2026-10-02T05:21:00Z",
        enteredPrNumber: 12,
      },
    ],
    fileCount: 1,
    candidates: [],
    openPromotionPullRequests: [],
    truncated: false,
    counts: { total: 0, unjudged: 0, judged: 0 },
    collectLimit: 100,
    docsRepoUrl: "https://github.com/guchi-apps/docs",
  };
}

describe("KnowledgeBoardPanel", () => {
  afterEach(() => cleanup());

  it("判定結果・ファイル別・入った順へ整理して表示する", () => {
    render(<KnowledgeBoardPanel data={boardData()} isLoading={false} error={null} onRefresh={() => {}} />);

    expect(screen.getByRole("button", { name: /判定結果/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /ファイル別/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /入った順/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /知見の候補/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /ファイル別/ }));
    expect(screen.getByRole("navigation", { name: "共通知識のファイル" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /github-actions.*1/ })).toBeTruthy();
  });

  it("知識カードを開くとMarkdown全文を表示する", () => {
    render(<KnowledgeBoardPanel data={boardData()} isLoading={false} error={null} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /ファイル別/ }));
    fireEvent.click(screen.getByText("全文を読める知識"));

    const details = screen.getByText("全文を読める知識").closest("details");
    expect(details?.open).toBe(true);
    expect(screen.getByText("詳細本文の続きです。")).toBeTruthy();
  });
});
