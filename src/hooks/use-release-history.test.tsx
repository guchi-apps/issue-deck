// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReleaseHistory } from "@/hooks/use-release-history";

type Deferred = { resolve: (body: unknown) => void };

/**
 * `release-history`のGETは手で応答を返せるようにし、保存（POST/DELETE）は即座に成功させる。
 * 取り直しの途中で押した切り替えが、押す前の記録を持った応答で巻き戻らないかを見る（#3797）。
 */
function stubFetch(saveOk = true) {
  const gets: Deferred[] = [];
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/repositories/release-history") {
      return new Promise((resolve) => {
        gets.push({ resolve: (body) => resolve({ ok: true, json: async () => body }) });
      });
    }
    return Promise.resolve({ ok: saveOk, status: saveOk ? 200 : 500, json: async () => ({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return gets;
}

const target = { repoFullName: "o/a", tagName: "v1.0.0" };
const lineTarget = { ...target, lineKey: "#12" };
const emptyResponse = { entries: [], checkRecords: [], checkLineRecords: [] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useReleaseHistory（#3797）", () => {
  it("取り直しの途中で押した確認済み・行チェックが、応答で未確認へ戻らない", async () => {
    const gets = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await act(async () => gets[0].resolve(emptyResponse));

    // 画面を開き直した等で取り直しが走っている間に押す
    act(() => result.current.refresh());
    await waitFor(() => expect(gets).toHaveLength(2));
    await act(async () => {
      await result.current.setReleaseChecked(target, true);
      await result.current.setReleaseLineChecked(lineTarget, true);
    });

    // 応答はDBを読んだ時点（押す前）の記録
    await act(async () => gets[1].resolve(emptyResponse));

    expect(result.current.checkRecords.map((r) => r.tagName)).toEqual(["v1.0.0"]);
    expect(result.current.checkLineRecords.map((r) => r.lineKey)).toEqual(["#12"]);
  });

  it("保存が済んだあとに始めた取り直しでは、応答の記録をそのまま使う", async () => {
    const gets = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await act(async () => gets[0].resolve(emptyResponse));
    await act(async () => {
      await result.current.setReleaseChecked(target, true);
    });

    // 別の端末で未確認へ戻された後の取り直し
    act(() => result.current.refresh());
    await waitFor(() => expect(gets).toHaveLength(2));
    await act(async () => gets[1].resolve(emptyResponse));

    expect(result.current.checkRecords).toEqual([]);
  });

  it("保存に失敗したら、その1件だけを戻す", async () => {
    const gets = stubFetch(false);
    const { result } = renderHook(() => useReleaseHistory(true));
    const other = { repoFullName: "o/b", tagName: "v2.0.0", checkedAt: "2026-10-01T00:00:00.000Z" };
    await act(async () => gets[0].resolve({ ...emptyResponse, checkRecords: [other] }));
    await act(async () => {
      await result.current.setReleaseChecked(target, true);
    });

    expect(result.current.checkRecords).toEqual([other]);
    expect(result.current.error).toBe("保存に失敗しました (500)");
  });
});
