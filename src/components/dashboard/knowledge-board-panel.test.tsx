// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PromotionKnowledgeList,
  PromotionPullRequestActions,
} from "@/components/dashboard/knowledge-board-panel";
import type { OpenPromotionPullRequest, PromotionKnowledgeFile } from "@/lib/knowledge-board";

function makePullRequest(
  overrides: Partial<OpenPromotionPullRequest> = {},
): OpenPromotionPullRequest {
  return {
    number: 134,
    title: "フリートの知見メモを共有知識へ格上げする",
    htmlUrl: "https://github.com/guchi-apps/docs/pull/134",
    createdAt: "2026-09-14T00:00:00.000Z",
    sourceIssues: [
      {
        repoFullName: "guchi-apps/issue-deck",
        number: 2950,
        htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/2950",
      },
    ],
    knowledgeChanges: [],
    ...overrides,
  };
}

function stubFetchOk() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PromotionPullRequestActions", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("マージすると既存のPRマージ機構を guchi-apps/docs 向けに叩き、完了を伝える", async () => {
    const fetchMock = stubFetchOk();
    const onDone = vi.fn();
    render(<PromotionPullRequestActions pr={makePullRequest()} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));
    fireEvent.click(screen.getAllByRole("button", { name: "マージする" }).at(-1)!);

    await screen.findByText("マージ済み");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/issues/pull-request-merge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ owner: "guchi-apps", repo: "docs", number: 134 }),
      }),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("マージしないと既存のPRクローズ機構を guchi-apps/docs 向けに叩き、完了を伝える", async () => {
    const fetchMock = stubFetchOk();
    const onDone = vi.fn();
    render(<PromotionPullRequestActions pr={makePullRequest()} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "マージしない" }));
    fireEvent.click(screen.getAllByRole("button", { name: "マージしない" }).at(-1)!);

    await screen.findByText("マージしませんでした");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/issues/pull-request-close",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ owner: "guchi-apps", repo: "docs", number: 134 }),
      }),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

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
