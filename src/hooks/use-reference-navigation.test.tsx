// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useReferenceNavigation } from "@/hooks/use-reference-navigation";

let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => currentSearchParams,
}));

// URLの更新はネイティブのHistory APIで行う（#1597。router.pushだとサーバーを往復する）
const push = vi.spyOn(window.history, "pushState").mockImplementation(() => {});

function renderNavigation(query = "") {
  currentSearchParams = new URLSearchParams(query);
  return renderHook(() => useReferenceNavigation());
}

/** pushState/replaceStateの第3引数（URL） */
function urlOf(call: unknown[]): string {
  return String(call[2]);
}

describe("useReferenceNavigation", () => {
  beforeEach(() => {
    push.mockClear();
  });

  it("Issueを開くとPC・スマホ両方の現在地を1回の更新で進める（#1260）", () => {
    const { result } = renderNavigation("view=all");

    act(() => result.current.openIssue("123"));

    expect(push).toHaveBeenCalledTimes(1);
    const url = urlOf(push.mock.calls[0]);
    expect(url).toContain("issue=123");
    expect(url).toContain("mscreen=issue-detail");
    expect(url).toContain("missue=123");
  });

  // 重ね表示（`prmodal`）の中にもIssue・PRのリンクが出る。残したまま遷移すると、下の画面
  // だけが進んで重ね表示が残り、閉じた先が押したときの一覧ではなくなる（#2149）。
  it("重ねて開いていたPR詳細は、リンクで遷移するときに畳む（Issueへ）", () => {
    const { result } = renderNavigation("view=check-user&prmodal=owner%2Frepo%2312");

    act(() => result.current.openIssue("123"));

    expect(urlOf(push.mock.calls[0])).not.toContain("prmodal=");
  });

  it("重ねて開いていたPR詳細は、リンクで遷移するときに畳む（別のPRへ）", () => {
    const { result } = renderNavigation("view=check-user&prmodal=owner%2Frepo%2312");

    act(() => result.current.openPullRequest("owner/repo#34"));

    const url = urlOf(push.mock.calls[0]);
    expect(url).not.toContain("prmodal=");
    expect(url).toContain("pane=pull-requests");
    expect(url).toContain("pr=owner%2Frepo%2334");
  });
});
