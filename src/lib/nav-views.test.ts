import { describe, expect, it } from "vitest";

import {
  getAdjacentNavViewId,
  getNavViewDefaultGroupByRepo,
  getNavViewDefaultState,
  navViewIgnoresIssueFilters,
  mobileListNavViews,
  navViewIcons,
  navViews,
  resolveMobileListNavViews,
  resolveStateOnViewChange,
  sidebarAttentionNavViews,
  sidebarIssueNavViews,
  sidebarQuestionNavViews,
} from "@/lib/nav-views";

describe("navViews", () => {
  it("「質問」「コードレビュー」は手作業と未着手のあいだに並ぶ（#1514・#698）", () => {
    const ids = navViews.map((view) => view.id);
    expect(ids.slice(ids.indexOf("manual-step"), ids.indexOf("not-started") + 1)).toEqual([
      "manual-step",
      "question",
      "code-review",
      "not-started",
    ]);
  });
});

describe("スマホの一覧に並べるビュー（#1645）", () => {
  it("先頭は「すべてのIssue」で、その次がユーザーの確認待ち（#714）", () => {
    expect(mobileListNavViews.slice(0, 2).map((view) => view.id)).toEqual(["all", "check-user"]);
  });

  it("お気に入り・最近追加した・直近本番に反映したは出さない", () => {
    const ids = mobileListNavViews.map((view) => view.id);
    expect(ids).not.toContain("favorites");
    expect(ids).not.toContain("recently-added");
    expect(ids).not.toContain("recently-merged");
  });

  // 左メニューへ足したので、揃える側のここにも出す（#1743）
  it("本番反映待ちは末尾に出す", () => {
    expect(mobileListNavViews.at(-1)?.id).toBe("release-pending");
  });

  it("一覧に無いビューで開かれたときだけ、そのビューを末尾へ足す", () => {
    expect(resolveMobileListNavViews("in-progress")).toBe(mobileListNavViews);

    const resolved = resolveMobileListNavViews("recently-merged");
    expect(resolved).toHaveLength(mobileListNavViews.length + 1);
    expect(resolved.at(-1)?.id).toBe("recently-merged");
  });

  it("足したビューからも左右のスワイプで隣のビューへ移動できる", () => {
    const resolved = resolveMobileListNavViews("recently-merged");

    expect(getAdjacentNavViewId("recently-merged", "prev", resolved)).toBe("release-pending");
    expect(getAdjacentNavViewId("recently-merged", "next", resolved)).toBeNull();
  });
});

describe("左メニューのグループ（#1613）", () => {
  it("要対応は人が動くまで進まない2つだけ", () => {
    expect(sidebarAttentionNavViews.map((view) => view.id)).toEqual(["check-user", "manual-step"]);
  });

  it("質問とコードレビューは要対応にもIssueにも入れない", () => {
    expect(sidebarQuestionNavViews.map((view) => view.id)).toEqual(["question", "code-review"]);
  });

  // 絞ったものどうしは進捗の順（未着手 → 実行中 → 本番反映待ち、#1743）
  it("Issueは広い順に5つ", () => {
    expect(sidebarIssueNavViews.map((view) => view.id)).toEqual([
      "all",
      "favorites",
      "not-started",
      "in-progress",
      "release-pending",
    ]);
  });

  // 隣り合う行が同じ線画だとどちらを押しているか分からなくなる
  it("すべてのIssueと未着手には別のアイコンを使う", () => {
    expect(navViewIcons.all).not.toBe(navViewIcons["not-started"]);
  });
});

describe("getNavViewDefaultState", () => {
  it("状態を要求しないビューはopen、「main反映済(直近)」はall", () => {
    expect(getNavViewDefaultState("all")).toBe("open");
    expect(getNavViewDefaultState("favorites")).toBe("open");
    expect(getNavViewDefaultState("recently-merged")).toBe("all");
  });

  it("質問ビューは「完了していない質問」を出すためopen（#1514）", () => {
    expect(getNavViewDefaultState("question")).toBe("open");
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

// #1750: リポジトリ横断で全体を見るビューは、ユーザーの絞り込みを適用しない
describe("navViewIgnoresIssueFilters", () => {
  it("要対応の2つと質問・コードレビューだけが対象になる", () => {
    const ignored = navViews.filter((view) => navViewIgnoresIssueFilters(view.id));
    expect(ignored.map((view) => view.id)).toEqual([
      "check-user",
      "manual-step",
      "question",
      "code-review",
    ]);
  });

  it("左メニュー最上段（要対応）はすべて対象（画像の並びと揃える）", () => {
    for (const view of [...sidebarAttentionNavViews, ...sidebarQuestionNavViews]) {
      expect(navViewIgnoresIssueFilters(view.id)).toBe(true);
    }
  });

  it("Issueセクションのビューは対象外（従来どおり絞り込みが効く）", () => {
    for (const view of sidebarIssueNavViews) {
      expect(navViewIgnoresIssueFilters(view.id)).toBe(false);
    }
  });
});
