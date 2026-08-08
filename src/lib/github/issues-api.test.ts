import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueTransferPartialError, transferIssue } from "@/lib/github/issues-api";

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
