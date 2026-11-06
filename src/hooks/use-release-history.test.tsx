// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReleaseHistory } from "@/hooks/use-release-history";

const CACHED = "/api/repositories/release-history/cached";
const TARGETS = "/api/repositories/release-history?scope=targets";
const OTHERS = "/api/repositories/release-history?scope=others";
const IOS = "/api/repositories/release-history/ios-status";

type Deferred = { resolve: (res: unknown) => void };

/**
 * GETは手で応答を返せるようにし、保存（POST/DELETE）は即座に成功させる。
 * 取り直しの途中で押した切り替えが、押す前の記録を持った応答で巻き戻らないかを見る（#3797）。
 */
function stubFetch(saveOk = true) {
  const calls = new Map<string, Deferred[]>();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string }) => {
      if (init?.method === "POST" || init?.method === "DELETE") {
        return Promise.resolve({ ok: saveOk, status: saveOk ? 200 : 500, json: async () => ({}) });
      }
      return new Promise((resolve) => {
        calls.set(url, [...(calls.get(url) ?? []), { resolve }]);
      });
    }),
  );
  const count = (url: string) => calls.get(url)?.length ?? 0;
  /** そのURLのn回目（0始まり）の呼び出しへ応答する */
  const respond = async (url: string, body: unknown, nth = 0, ok = true) => {
    await waitFor(() => expect(count(url)).toBeGreaterThan(nth));
    await act(async () => calls.get(url)![nth].resolve({ ok, status: ok ? 200 : 500, json: async () => body }));
  };
  return { count, respond };
}

const target = { repoFullName: "o/a", tagName: "v1.0.0" };
const lineTarget = { ...target, lineKey: "#12" };
const emptyResponse = { entries: [], checkRecords: [], checkLineRecords: [] };

function release(repoFullName: string, tagName: string, publishedAt = "2026-11-04T00:00:00Z", body: string | null = null) {
  return { repoFullName, tagName, name: tagName, htmlUrl: "https://example.com", publishedAt, body };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useReleaseHistory（#3797）", () => {
  it("取り直しの途中で押した確認済み・行チェックが、応答で未確認へ戻らない", async () => {
    const { respond, count } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(TARGETS, { ...emptyResponse, repositories: ["o/a"] });
    await respond(OTHERS, { ...emptyResponse, repositories: [] });

    // 画面を開き直した等で取り直しが走っている間に押す
    act(() => result.current.refresh());
    await waitFor(() => expect(count(TARGETS)).toBe(2));
    await act(async () => {
      await result.current.setReleaseChecked(target, true);
      await result.current.setReleaseLineChecked(lineTarget, true);
    });

    // 応答はDBを読んだ時点（押す前）の記録
    await respond(OTHERS, { ...emptyResponse, repositories: [] }, 1);
    await respond(TARGETS, { ...emptyResponse, repositories: ["o/a"] }, 1);

    expect(result.current.checkRecords.map((r) => r.tagName)).toEqual(["v1.0.0"]);
    expect(result.current.checkLineRecords.map((r) => r.lineKey)).toEqual(["#12"]);
  });

  it("保存が済んだあとに始めた取り直しでは、応答の記録をそのまま使う", async () => {
    const { respond, count } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(TARGETS, { ...emptyResponse, repositories: [] });
    await respond(OTHERS, { ...emptyResponse, repositories: [] });
    await act(async () => {
      await result.current.setReleaseChecked(target, true);
    });

    // 別の端末で未確認へ戻された後の取り直し
    act(() => result.current.refresh());
    await waitFor(() => expect(count(TARGETS)).toBe(2));
    await respond(TARGETS, { ...emptyResponse, repositories: [] }, 1);

    expect(result.current.checkRecords).toEqual([]);
  });

  it("保存が済んだ行チェックは、別のリポジトリの応答が先に届いても戻らない（#5230）", async () => {
    const { respond, count } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(TARGETS, { ...emptyResponse, repositories: ["o/a"] });
    await respond(OTHERS, { ...emptyResponse, repositories: ["o/b"] });
    await act(async () => {
      await result.current.setReleaseLineChecked(lineTarget, true);
    });

    act(() => result.current.refresh());
    await waitFor(() => expect(count(OTHERS)).toBe(2));
    await respond(OTHERS, { ...emptyResponse, repositories: ["o/b"] }, 1);

    expect(result.current.checkLineRecords.map((r) => r.lineKey)).toEqual(["#12"]);
  });

  it("保存に失敗したら、その1件だけを戻す", async () => {
    const { respond } = stubFetch(false);
    const { result } = renderHook(() => useReleaseHistory(true));
    const other = { repoFullName: "o/b", tagName: "v2.0.0", checkedAt: "2026-10-01T00:00:00.000Z" };
    await respond(TARGETS, { ...emptyResponse, repositories: [], checkRecords: [other] });
    await act(async () => {
      await result.current.setReleaseChecked(target, true);
    });

    expect(result.current.checkRecords).toEqual([other]);
    expect(result.current.error).toBe("保存に失敗しました (500)");
  });
});

describe("useReleaseHistory の段階取得（#5230）", () => {
  it("前回の取得結果を先に出し、確認対象→その他の順に最新へ差し替える", async () => {
    const { respond } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));

    await respond(CACHED, {
      ...emptyResponse,
      repositories: ["o/a", "o/b"],
      entries: [release("o/a", "v1.0.0"), release("o/b", "v2.0.0")],
      fetchedAt: "2026-11-06T05:32:00.000Z",
    });
    expect(result.current.freshness).toBe("stale");
    expect(result.current.fetchedAt).toBe("2026-11-06T05:32:00.000Z");
    expect(result.current.entries?.map((e) => e.tagName)).toEqual(["v1.0.0", "v2.0.0"]);

    await respond(TARGETS, {
      ...emptyResponse,
      repositories: ["o/a"],
      entries: [release("o/a", "v1.1.0", "2026-11-05T00:00:00Z")],
      fetchedAt: "2026-11-06T05:35:00.000Z",
    });
    expect(result.current.freshness).toBe("partial");
    expect(result.current.isLoading).toBe(true);
    // o/aだけが差し替わり、o/bは前回の値のまま
    expect(result.current.entries?.map((e) => e.tagName)).toEqual(["v1.1.0", "v2.0.0"]);

    await respond(OTHERS, { ...emptyResponse, repositories: ["o/b"], entries: [], fetchedAt: "2026-11-06T05:35:01.000Z" });
    expect(result.current.freshness).toBe("fresh");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.entries?.map((e) => e.tagName)).toEqual(["v1.1.0"]);
  });

  it("最新が先に届いていれば、前回の取得結果で上書きしない", async () => {
    const { respond } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));

    await respond(TARGETS, { ...emptyResponse, repositories: ["o/a"], entries: [release("o/a", "v1.1.0")] });
    await respond(CACHED, {
      ...emptyResponse,
      repositories: ["o/a"],
      entries: [release("o/a", "v1.0.0")],
      fetchedAt: "2026-11-06T05:32:00.000Z",
    });

    expect(result.current.freshness).toBe("partial");
    expect(result.current.entries?.map((e) => e.tagName)).toEqual(["v1.1.0"]);
  });

  it("その他が先に届いても、確認対象が届くまでは押せる状態にしない", async () => {
    const { respond } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(CACHED, { ...emptyResponse, repositories: ["o/a"], entries: [release("o/a", "v1.0.0")], fetchedAt: "2026-11-06T05:32:00.000Z" });
    await respond(OTHERS, { ...emptyResponse, repositories: ["o/b"], entries: [release("o/b", "v2.0.0")] });

    expect(result.current.freshness).toBe("stale");
    expect(result.current.entries?.map((e) => e.tagName)).toEqual(["v1.0.0", "v2.0.0"]);
  });

  it("取得に失敗したリポジトリ（応答の受け持ちに無い）は前回の値を残す", async () => {
    const { respond } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(CACHED, {
      ...emptyResponse,
      repositories: ["o/a", "o/c"],
      entries: [release("o/a", "v1.0.0"), release("o/c", "v3.0.0")],
      fetchedAt: "2026-11-06T05:32:00.000Z",
    });
    await respond(TARGETS, { ...emptyResponse, repositories: ["o/a"], entries: [release("o/a", "v1.1.0")] });

    expect(result.current.entries?.map((e) => e.tagName).sort()).toEqual(["v1.1.0", "v3.0.0"]);
  });

  it("確認対象の取得に失敗したリポジトリが残る間は、staleのまま確認操作をロックする（#5234）", async () => {
    const { respond } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(CACHED, {
      ...emptyResponse,
      repositories: ["o/a"],
      entries: [release("o/a", "v1.0.0")],
      fetchedAt: "2026-11-06T05:32:00.000Z",
    });
    await respond(TARGETS, { ...emptyResponse, repositories: [], failedRepositories: ["o/a"] });
    await respond(OTHERS, { ...emptyResponse, repositories: ["o/b"], entries: [] });

    expect(result.current.freshness).toBe("stale");
    expect(result.current.error).toContain("一部のリポジトリ");
    expect(result.current.entries?.map((e) => e.tagName)).toEqual(["v1.0.0"]);
  });

  it("fresh後の取り直しで確認対象が失敗したらstaleへ戻り、解消すればfreshへ復帰する（#5234）", async () => {
    const { respond } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(TARGETS, { ...emptyResponse, repositories: ["o/a"], entries: [release("o/a", "v1.0.0")] });
    await respond(OTHERS, { ...emptyResponse, repositories: [] });
    expect(result.current.freshness).toBe("fresh");

    act(() => result.current.refresh());
    await respond(TARGETS, { ...emptyResponse, repositories: [], failedRepositories: ["o/a"] }, 1);
    await respond(OTHERS, { ...emptyResponse, repositories: [] }, 1);
    expect(result.current.freshness).toBe("stale");

    act(() => result.current.refresh());
    await respond(TARGETS, { ...emptyResponse, repositories: ["o/a"], entries: [release("o/a", "v1.0.1")] }, 2);
    await respond(OTHERS, { ...emptyResponse, repositories: [] }, 2);
    expect(result.current.freshness).toBe("fresh");
    expect(result.current.error).toBeNull();
  });

  it("取り直し（更新ボタン）では前回の取得結果を取りに行かない", async () => {
    const { respond, count } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(TARGETS, { ...emptyResponse, repositories: [] });
    await respond(OTHERS, { ...emptyResponse, repositories: [] });
    expect(count(CACHED)).toBe(1);

    act(() => result.current.refresh());
    await waitFor(() => expect(count(TARGETS)).toBe(2));
    expect(count(CACHED)).toBe(1);
    expect(result.current.freshness).toBe("fresh");
  });
});

describe("useReleaseHistory のiOS配布の状況（#5214）", () => {
  it("一覧はiOSの応答を待たずに出し、届いたら重ねる", async () => {
    const { respond } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(TARGETS, { ...emptyResponse, repositories: ["o/a"], entries: [release("o/a", "v1.0.0")] });
    await respond(OTHERS, { ...emptyResponse, repositories: [] });

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.iosStatusLoading).toBe(true);
    expect(result.current.entries?.[0].iosDeliveredBuild).toBeUndefined();

    await respond(IOS, {
      statuses: [{ repoFullName: "o/a", delivered: { "v1.0.0": 12 }, failed: {}, hasActiveRun: false }],
      failedRepositories: [],
    });
    expect(result.current.iosStatusLoading).toBe(false);
    expect(result.current.iosStatusError).toBeNull();
    expect(result.current.entries?.[0].iosDeliveredBuild).toBe(12);
  });

  it("iOSの取得に失敗しても一覧は残り、案内だけを出す", async () => {
    const { respond } = stubFetch();
    const { result } = renderHook(() => useReleaseHistory(true));
    await respond(TARGETS, { ...emptyResponse, repositories: ["o/a"], entries: [release("o/a", "v1.0.0")] });
    await respond(OTHERS, { ...emptyResponse, repositories: [] });

    await respond(IOS, {}, 0, false);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(result.current.iosStatusLoading).toBe(false);
    expect(result.current.iosStatusError).toContain("iOS配布の状況");
  });
});
