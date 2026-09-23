// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hydrateIssueBodies, useIssueBodies } from "@/hooks/use-issue-bodies";
import type { Issue } from "@/types/issue";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1,
    title: "サンプルIssue",
    body: "",
    bodyOmitted: true,
    state: "closed",
    stateReason: "completed",
    repositoryFullName: "owner/repo",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    closedAt: "2026-01-02T00:00:00.000Z",
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/owner/repo/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

describe("hydrateIssueBodies（#3390）", () => {
  it("取得済みの本文を差し込み、本文を外した印を消す", () => {
    const [hydrated] = hydrateIssueBodies(
      [makeIssue()],
      new Map([["1", { body: "本文", updatedAt: "2026-01-02T00:00:00.000Z" }]]),
      new Map(),
    );
    expect(hydrated.body).toBe("本文");
    expect(hydrated.bodyOmitted).toBeUndefined();
  });

  it("一覧の版より古い本文は使わない（編集後に古い本文を出さない）", () => {
    const issue = makeIssue({ updatedAt: "2026-01-03T00:00:00.000Z" });
    const [hydrated] = hydrateIssueBodies(
      [issue],
      new Map([["1", { body: "古い本文", updatedAt: "2026-01-02T00:00:00.000Z" }]]),
      new Map(),
    );
    expect(hydrated).toBe(issue);
  });

  it("失敗した版には失敗の印を立てる", () => {
    const [hydrated] = hydrateIssueBodies(
      [makeIssue()],
      new Map(),
      new Map([["1", "2026-01-02T00:00:00.000Z"]]),
    );
    expect(hydrated.bodyOmitted).toBe(true);
    expect(hydrated.bodyLoadFailed).toBe(true);
  });

  it("同じIssue・同じ本文なら差し込んだ版を使い回す", () => {
    const issue = makeIssue();
    const loaded = new Map([["1", { body: "本文", updatedAt: "2026-01-02T00:00:00.000Z" }]]);
    const cache = new WeakMap();
    const [first] = hydrateIssueBodies([issue], loaded, new Map(), cache);
    const [second] = hydrateIssueBodies([issue], loaded, new Map(), cache);
    expect(second).toBe(first);
  });
});

describe("useIssueBodies（#3390）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ body: "取った本文", updatedAt: "2026-01-02T00:00:00.000Z" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("頼まれるまでは取らない", async () => {
    renderHook(() => useIssueBodies([makeIssue()]));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("頼まれたIssueの本文を1回だけ取って差し込む", async () => {
    const issues = [makeIssue(), makeIssue({ id: "2", number: 2 })];
    const { result } = renderHook(() => useIssueBodies(issues));
    act(() => result.current.request("1"));

    await waitFor(() => expect(result.current.issues[0].body).toBe("取った本文"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/issues/body?id=1");
    // 頼んでいないIssueは本文を外したまま
    expect(result.current.issues[1].bodyOmitted).toBe(true);
  });

  it("本文を持っているIssueは取りに行かない", async () => {
    const issues = [makeIssue({ state: "open", body: "本文", bodyOmitted: undefined })];
    const { result } = renderHook(() => useIssueBodies(issues));
    act(() => result.current.request("1"));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.issues[0].body).toBe("本文");
  });

  it("本文入りで届いた版を覚え、本文を外した版に置き換わっても取り直さない", async () => {
    const full = makeIssue({ body: "編集後の本文", bodyOmitted: undefined });
    const { result, rerender } = renderHook(({ issues }) => useIssueBodies(issues), {
      initialProps: { issues: [full] },
    });
    act(() => result.current.request("1"));
    rerender({ issues: [makeIssue()] });
    await act(async () => {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.issues[0].body).toBe("編集後の本文");
  });

  it("取得に失敗したら失敗の印を立て、頼み直すともう一度取る", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const issues = [makeIssue()];
    const { result } = renderHook(() => useIssueBodies(issues));
    act(() => result.current.request("1"));
    await waitFor(() => expect(result.current.issues[0].bodyLoadFailed).toBe(true));

    act(() => result.current.request("1"));
    await waitFor(() => expect(result.current.issues[0].body).toBe("取った本文"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
