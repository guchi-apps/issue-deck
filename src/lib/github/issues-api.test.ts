import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchRepositoryComments,
  hasReopenedEvent,
  IssueTransferPartialError,
  transferIssue,
} from "@/lib/github/issues-api";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("transferIssue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("移動後の再取得が最初から成功する場合はそのまま結果を返す", async () => {
    const fetchMock = vi
      .fn()
      // 移動元Issueのnode_id取得
      .mockResolvedValueOnce(jsonResponse(200, { node_id: "issue-node" }))
      // 移動先リポジトリのnode_id取得
      .mockResolvedValueOnce(jsonResponse(200, { node_id: "repo-node" }))
      // GraphQL transferIssue
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { transferIssue: { issue: { number: 5 } } } }),
      )
      // 移動後の再取得
      .mockResolvedValueOnce(jsonResponse(200, { id: 999, number: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await transferIssue("owner", "repo", 1, "new-owner", "new-repo", "token");

    expect(result).toEqual({ id: 999, number: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("移動後の再取得が一時的に404になっても、リトライの末に成功すれば結果を返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { node_id: "issue-node" }))
      .mockResolvedValueOnce(jsonResponse(200, { node_id: "repo-node" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { transferIssue: { issue: { number: 5 } } } }),
      )
      // 再取得: 1回目・2回目は404、3回目で成功
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse(404, { message: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 999, number: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = transferIssue("owner", "repo", 1, "new-owner", "new-repo", "token");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ id: 999, number: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("再取得がリトライ上限まで失敗し続けた場合はIssueTransferPartialErrorを投げる", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { node_id: "issue-node" }))
      .mockResolvedValueOnce(jsonResponse(200, { node_id: "repo-node" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { transferIssue: { issue: { number: 5 } } } }),
      )
      .mockResolvedValue(jsonResponse(404, { message: "Not Found" }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = transferIssue("owner", "repo", 1, "new-owner", "new-repo", "token");
    const expectation = expect(promise).rejects.toBeInstanceOf(IssueTransferPartialError);
    await vi.runAllTimersAsync();
    await expectation;

    const error = (await promise.catch((e: unknown) => e)) as IssueTransferPartialError;
    expect(error.newNumber).toBe(5);
  });
});

describe("fetchRepositoryComments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pageResponse(body: unknown, next?: string) {
    return {
      ok: true,
      status: 200,
      headers: new Headers(next ? { link: `<${next}>; rel="next"` } : {}),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  it("`since`・`sort=updated`・`direction=asc`を付けて引く", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pageResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await fetchRepositoryComments("guchi-apps", "issue-deck", "token", {
      since: new Date("2026-08-01T00:00:00.000Z"),
      maxPages: 3,
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/repos/guchi-apps/issue-deck/issues/comments");
    expect(url.searchParams.get("since")).toBe("2026-08-01T00:00:00.000Z");
    // ページングの最中に更新が入っても取りこぼさない向き（`desc`にすると読み飛ばす）
    expect(url.searchParams.get("sort")).toBe("updated");
    expect(url.searchParams.get("direction")).toBe("asc");
    expect(url.searchParams.get("per_page")).toBe("100");
  });

  it("一度も読んでいなければ`since`を付けない（全件から読む）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pageResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await fetchRepositoryComments("guchi-apps", "issue-deck", "token", {
      since: null,
      maxPages: 3,
    });

    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.has("since")).toBe(false);
  });

  it("ページ数の上限で打ち切り、続きが残っていることを返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([{ id: 1 }], "https://api.github.com/next-1"))
      .mockResolvedValueOnce(pageResponse([{ id: 2 }], "https://api.github.com/next-2"))
      .mockResolvedValueOnce(pageResponse([{ id: 3 }], "https://api.github.com/next-3"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRepositoryComments("guchi-apps", "issue-deck", "token", {
      since: null,
      maxPages: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.comments.map((comment) => comment.id)).toEqual([1, 2]);
    expect(result.hasMore).toBe(true);
  });
});

describe("hasReopenedEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function eventsResponse(events: { event: string }[]) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => events,
      text: async () => JSON.stringify(events),
    };
  }

  it("reopenイベントがあればtrue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(eventsResponse([{ event: "closed" }, { event: "reopened" }])),
    );

    await expect(hasReopenedEvent("guchi-apps", "issue-deck", 1, "token")).resolves.toBe(true);
  });

  it("一度もcloseされていなければfalse", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(eventsResponse([{ event: "labeled" }])));

    await expect(hasReopenedEvent("guchi-apps", "issue-deck", 1, "token")).resolves.toBe(false);
  });

  it("取得に失敗したらnull（確かめられないものは閉じない）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "not found",
      }),
    );

    await expect(hasReopenedEvent("guchi-apps", "issue-deck", 1, "token")).resolves.toBeNull();
  });
});
