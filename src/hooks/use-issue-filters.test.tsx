// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useIssueFilters } from "@/hooks/use-issue-filters";

let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => currentSearchParams,
}));

// URLの更新はネイティブのHistory APIで行う（#1597。router.pushだとサーバーを往復する）
const push = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
const replace = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});

/** pushState/replaceStateの第3引数（URL） */
function urlOf(call: unknown[]): string {
  return String(call[2]);
}

function renderFilters(query = "") {
  currentSearchParams = new URLSearchParams(query);
  return renderHook(() => useIssueFilters());
}

describe("useIssueFilters の履歴の積み方（#1396）", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
  });

  it("現在地が変わる操作（ビュー切替）は履歴を積む", () => {
    const { result } = renderFilters();

    act(() => result.current.selectView("favorites"));

    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(urlOf(push.mock.calls[0])).toContain("view=favorites");
  });

  it("ビューを切り替えたら選択中Issueも同じ1回の更新で畳む", () => {
    const { result } = renderFilters("view=all&issue=123");

    act(() => result.current.selectView("favorites"));

    expect(push).toHaveBeenCalledTimes(1);
    expect(urlOf(push.mock.calls[0])).not.toContain("issue=");
  });

  it("絞り込み条件（キーワード・状態・ラベル）は履歴を積まない", () => {
    const { result } = renderFilters();

    act(() => result.current.setFilter("q", "deck"));
    act(() => result.current.setFilter("state", "closed"));
    act(() => result.current.toggleLabel("bug"));

    expect(replace).toHaveBeenCalledTimes(3);
    expect(push).not.toHaveBeenCalled();
  });

  it("PRは開くときだけ履歴を積み、閉じるときは積まない", () => {
    const { result } = renderFilters();

    act(() => result.current.selectPullRequest("owner/repo#12"));
    expect(push).toHaveBeenCalledTimes(1);

    currentSearchParams = new URLSearchParams("pr=owner%2Frepo%2312");
    const closing = renderHook(() => useIssueFilters());
    act(() => closing.result.current.selectPullRequest(null));

    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("結果が今のURLと同じなら遷移しない（戻る操作が2回必要になるのを防ぐ）", () => {
    const { result } = renderFilters("view=favorites");

    act(() => result.current.setFilter("view", "favorites"));

    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
