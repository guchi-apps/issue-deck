// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMobileScreen } from "@/hooks/use-mobile-screen";
import { recordHistoryPush, resetHistoryStack } from "@/lib/history-stack";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

const push = vi.fn();
const replace = vi.fn();
const back = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, back }),
  usePathname: () => "/dashboard",
  useSearchParams: () => currentSearchParams,
}));

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
    const url = push.mock.calls[0][0] as string;
    expect(url).toContain("mscreen=issue-detail");
    expect(url).toContain("missue=1001");
    expect(url).toContain("issue=1001");
  });

  it("一覧へ戻る遷移ではPC側の選択中Issueを畳む", () => {
    const { result } = renderMobileScreen("mscreen=issue-detail&missue=1001&issue=1001");

    act(() => result.current.selectTab("repos"));

    expect(push.mock.calls[0][0] as string).not.toContain("issue=1001");
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
    const url = replace.mock.calls[0][0] as string;
    expect(url).toContain("mscreen=issues");
    expect(url).toContain("missue=1001");
  });
});
