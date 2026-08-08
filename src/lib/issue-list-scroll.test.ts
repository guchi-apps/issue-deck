import { describe, expect, it } from "vitest";

import {
  buildIssueListScrollKey,
  collectIssueListScrollAnchors,
  computeCenteredIssueListScrollTop,
  computeRestoredIssueListScrollTop,
  type IssueListItemOffset,
} from "@/lib/issue-list-scroll";

// 行の高さを100pxとした等間隔のリスト
function items(ids: string[], height = 100): IssueListItemOffset[] {
  return ids.map((issueId, index) => ({ issueId, offsetTop: index * height }));
}

describe("collectIssueListScrollAnchors", () => {
  it("ビューポート上端に部分的に隠れている行を先頭アンカーにする", () => {
    const anchors = collectIssueListScrollAnchors(items(["a", "b", "c", "d"]), 150, 2);

    expect(anchors).toEqual([
      { issueId: "b", offsetFromTop: -50 },
      { issueId: "c", offsetFromTop: 50 },
    ]);
  });

  it("行の上端とscrollTopが一致する場合、その行のoffsetFromTopは0になる", () => {
    const anchors = collectIssueListScrollAnchors(items(["a", "b", "c"]), 100, 1);

    expect(anchors).toEqual([{ issueId: "b", offsetFromTop: 0 }]);
  });

  it("先頭にいる場合は先頭行から拾う", () => {
    const anchors = collectIssueListScrollAnchors(items(["a", "b", "c"]), 0, 2);

    expect(anchors).toEqual([
      { issueId: "a", offsetFromTop: 0 },
      { issueId: "b", offsetFromTop: 100 },
    ]);
  });

  it("末尾付近では残っている行数分だけ拾う", () => {
    const anchors = collectIssueListScrollAnchors(items(["a", "b", "c"]), 250, 5);

    expect(anchors).toEqual([{ issueId: "c", offsetFromTop: -50 }]);
  });

  it("行が無い場合は空配列を返す", () => {
    expect(collectIssueListScrollAnchors([], 0)).toEqual([]);
  });
});

describe("computeRestoredIssueListScrollTop", () => {
  const offsets = new Map([
    ["a", 0],
    ["b", 100],
    ["c", 200],
  ]);
  const lookup = (issueId: string) => offsets.get(issueId);

  it("先頭アンカーが残っていれば、保存時と同じ表示位置になるscrollTopを返す", () => {
    const scrollTop = computeRestoredIssueListScrollTop(
      { anchors: [{ issueId: "b", offsetFromTop: -50 }], scrollTop: 9999 },
      lookup,
      1000,
    );

    expect(scrollTop).toBe(150);
  });

  it("先頭アンカーが消えていても、残っている次のアンカーで復元する", () => {
    const scrollTop = computeRestoredIssueListScrollTop(
      {
        anchors: [
          { issueId: "removed", offsetFromTop: -50 },
          { issueId: "c", offsetFromTop: 50 },
        ],
        scrollTop: 9999,
      },
      lookup,
      1000,
    );

    expect(scrollTop).toBe(150);
  });

  it("アンカーが全て消えている場合は保存済みscrollTopにフォールバックする", () => {
    const scrollTop = computeRestoredIssueListScrollTop(
      { anchors: [{ issueId: "removed", offsetFromTop: 0 }], scrollTop: 120 },
      lookup,
      1000,
    );

    expect(scrollTop).toBe(120);
  });

  it("フォールバック時もスクロール可能範囲にクランプする", () => {
    const scrollTop = computeRestoredIssueListScrollTop(
      { anchors: [], scrollTop: 9999 },
      lookup,
      300,
    );

    expect(scrollTop).toBe(300);
  });

  it("アンカーから求めた位置が負になる場合は0にクランプする", () => {
    const scrollTop = computeRestoredIssueListScrollTop(
      { anchors: [{ issueId: "a", offsetFromTop: 200 }], scrollTop: 0 },
      lookup,
      1000,
    );

    expect(scrollTop).toBe(0);
  });

  it("スクロールできない高さの場合は0を返す", () => {
    const scrollTop = computeRestoredIssueListScrollTop(
      { anchors: [{ issueId: "c", offsetFromTop: 0 }], scrollTop: 200 },
      lookup,
      0,
    );

    expect(scrollTop).toBe(0);
  });
});

describe("computeCenteredIssueListScrollTop", () => {
  it("対象行がビューポート中央に来るscrollTopを返す", () => {
    expect(computeCenteredIssueListScrollTop(1000, 100, 400, 5000)).toBe(850);
  });

  it("先頭付近では0にクランプする", () => {
    expect(computeCenteredIssueListScrollTop(50, 100, 400, 5000)).toBe(0);
  });

  it("末尾付近では最大scrollTopにクランプする", () => {
    expect(computeCenteredIssueListScrollTop(4900, 100, 400, 5000)).toBe(4750);
    expect(computeCenteredIssueListScrollTop(5400, 100, 400, 5000)).toBe(5000);
  });
});

describe("buildIssueListScrollKey", () => {
  it("null・undefinedを空文字として連結する", () => {
    expect(buildIssueListScrollKey(["mobile-issues", "all", null, undefined, "created"])).toBe(
      "mobile-issues|all|||created",
    );
  });

  it("絞り込み条件が違えば異なるキーになる", () => {
    expect(buildIssueListScrollKey(["pc", "all"])).not.toBe(
      buildIssueListScrollKey(["pc", "check-user"]),
    );
  });
});
