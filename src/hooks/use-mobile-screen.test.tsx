// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMobileScreen } from "@/hooks/use-mobile-screen";
import { recordHistoryPush, resetHistoryStack } from "@/lib/history-stack";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

const back = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back }),
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

const issues = [{ id: "1001" }, { id: "1002" }] as unknown as Issue[];
const repositories = [] as ConnectedRepository[];

function renderMobileScreen(query = "") {
  currentSearchParams = new URLSearchParams(query);
  return renderHook(() => useMobileScreen(issues, repositories));
}

describe("useMobileScreen の履歴の積み方（#1396）", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    back.mockClear();
    resetHistoryStack();
  });

  it("画面遷移（Issue詳細を開く）は履歴を積み、PC側の選択中Issueも同じ1回で揃える", () => {
    const { result } = renderMobileScreen("mscreen=issues");

    act(() => result.current.selectIssue(issues[0]));

    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    const url = urlOf(push.mock.calls[0]);
    expect(url).toContain("mscreen=issue-detail");
    expect(url).toContain("missue=1001");
    expect(url).toContain("issue=1001");
  });

  it("一覧へ戻る遷移ではPC側の選択中Issueを畳む", () => {
    const { result } = renderMobileScreen("mscreen=issue-detail&missue=1001&issue=1001");

    act(() => result.current.selectTab("repos"));

    expect(urlOf(push.mock.calls[0])).not.toContain("issue=1001");
  });

  // 重ね表示（`prmodal`）は下の画面を残したまま出るので、画面が変わったのに残ると閉じた先が
  // 押したときの画面ではなくなる（#2149）。
  it("画面遷移では、重ねて開いていたPR詳細も畳む", () => {
    const { result } = renderMobileScreen("mscreen=issues&prmodal=owner%2Frepo%2312");

    act(() => result.current.selectIssue(issues[0]));

    expect(urlOf(push.mock.calls[0])).not.toContain("prmodal=");
  });

  it("絞り込みシート内の操作（silent）は履歴を積まない", () => {
    const { result } = renderMobileScreen("mscreen=issues");

    act(() => result.current.updateListFilters({ state: "closed" }));

    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("戻る操作は、自分が積んだ履歴があれば巻き戻す", () => {
    const { result } = renderMobileScreen("mscreen=issue-detail&missue=1001");
    recordHistoryPush();

    act(() => result.current.goBack());

    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("共有URLで詳細を直接開いた場合は、履歴を増やさずに戻り先の一覧へ遷移する", () => {
    const { result } = renderMobileScreen("mscreen=issue-detail&missue=1001");

    act(() => result.current.goBack());

    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    const url = urlOf(replace.mock.calls[0]);
    expect(url).toContain("mscreen=issues");
    expect(url).toContain("missue=1001");
  });
});

describe("フッターの「PR」タブが開くビュー（#2176）", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    back.mockClear();
    resetHistoryStack();
  });

  it("「マージ待ち」（prview=completed）で開く", () => {
    const { result } = renderMobileScreen("mscreen=home");

    act(() => result.current.selectTab("pull-requests"));

    const url = urlOf(push.mock.calls[0]);
    expect(url).toContain("mscreen=pull-requests");
    expect(url).toContain("prview=completed");
  });

  it("別のビューを見ている最中でも「マージ待ち」へ戻す", () => {
    const { result } = renderMobileScreen("mscreen=pull-requests&prview=in-progress");

    act(() => result.current.selectTab("pull-requests"));

    expect(urlOf(push.mock.calls[0])).toContain("prview=completed");
  });
});
