import { describe, expect, it } from "vitest";

import {
  getAdjacentNavViewId,
  getNavViewDefaultGroupByRepo,
  getNavViewDefaultState,
  navViews,
  resolveStateOnViewChange,
} from "@/lib/nav-views";

describe("getNavViewDefaultState", () => {
  it("状態を要求しないビューはopen、「main反映済(直近)」はall", () => {
    expect(getNavViewDefaultState("all")).toBe("open");
    expect(getNavViewDefaultState("favorites")).toBe("open");
    expect(getNavViewDefaultState("recently-merged")).toBe("all");
  });
});

describe("getNavViewDefaultGroupByRepo", () => {
  it("未着手はリポジトリ横断でまとめて表示するためデフォルトOFF（#876）", () => {
    expect(getNavViewDefaultGroupByRepo("not-started")).toBe(false);
  });

  it("実行中・本番関連待ちはリポジトリごとに見通しが良いためデフォルトON", () => {
    expect(getNavViewDefaultGroupByRepo("in-progress")).toBe(true);
    expect(getNavViewDefaultGroupByRepo("release-pending")).toBe(true);
    expect(getNavViewDefaultGroupByRepo("recently-merged")).toBe(true);
  });

  it("確認待ちは古い順の優先順位付けを崩さないためデフォルトOFF", () => {
    expect(getNavViewDefaultGroupByRepo("check-user")).toBe(false);
  });

  it("ラベル絞り込みを持たないビューはデフォルトOFF", () => {
    expect(getNavViewDefaultGroupByRepo("all")).toBe(false);
    expect(getNavViewDefaultGroupByRepo("favorites")).toBe(false);
  });
});

describe("resolveStateOnViewChange", () => {
  it("状態を要求するビューへ切り替えると、明示的な選択より要求を優先する", () => {
    // Issue #475: リポジトリ画面でopen絞り込みのまま選ぶと必ず0件になっていた。
    expect(resolveStateOnViewChange("recently-merged", "all", "open", true)).toBe("all");
    expect(resolveStateOnViewChange("recently-merged", "favorites", "closed", true)).toBe("all");
    expect(resolveStateOnViewChange("recently-merged", "all", "open", false)).toBe("all");
  });

  it("状態を要求しないビューへの切り替えでは、明示的に選ばれた状態を引き継ぐ", () => {
    expect(resolveStateOnViewChange("favorites", "all", "closed", true)).toBe("closed");
    expect(resolveStateOnViewChange("check-user", "all", "all", true)).toBe("all");
  });

  it("明示的に選ばれていない状態は、切り替え先ビューの既定値に戻す", () => {
    // 「main反映済(直近)」で暗黙に適用されていたallを、お気に入りへ持ち込まない。
    expect(resolveStateOnViewChange("favorites", "recently-merged", "all", false)).toBe("open");
    expect(resolveStateOnViewChange("all", "recently-merged", "all", false)).toBe("open");
  });

  it("同じビューを選び直したときは、そのビューでの明示的な選択を上書きしない", () => {
    expect(resolveStateOnViewChange("recently-merged", "recently-merged", "open", true)).toBe(
      "open",
    );
    expect(resolveStateOnViewChange("favorites", "favorites", "closed", true)).toBe("closed");
  });
});

describe("getAdjacentNavViewId", () => {
  it("nextを指定すると次のビューIDを返す", () => {
    expect(getAdjacentNavViewId("all", "next")).toBe("favorites");
  });

  it("prevを指定すると前のビューIDを返す", () => {
    expect(getAdjacentNavViewId("favorites", "prev")).toBe("all");
  });

  it("先頭のビューでprevを指定するとnullを返す（ループしない）", () => {
    expect(getAdjacentNavViewId(navViews[0].id, "prev")).toBeNull();
  });

  it("末尾のビューでnextを指定するとnullを返す（ループしない）", () => {
    const lastView = navViews[navViews.length - 1];
    expect(getAdjacentNavViewId(lastView.id, "next")).toBeNull();
  });

  it("orderを指定すると、navViewsではなくその並び順で隣接判定する（#734）", () => {
    // スマホのタブ表示順（#714でユーザーの確認待ちを先頭近くに固定表示）を想定した並び。
    const tabOrder = [navViews[0], navViews[3], navViews[1], navViews[2]];

    expect(getAdjacentNavViewId(navViews[0].id, "next", tabOrder)).toBe(navViews[3].id);
    expect(getAdjacentNavViewId(navViews[3].id, "prev", tabOrder)).toBe(navViews[0].id);
    expect(getAdjacentNavViewId(navViews[3].id, "next", tabOrder)).toBe(navViews[1].id);
  });
});
