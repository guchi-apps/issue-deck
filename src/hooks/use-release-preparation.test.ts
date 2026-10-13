// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReleasePreparation } from "@/hooks/use-release-preparation";

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

describe("useReleasePreparation（#4556）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("取得前と取得失敗の間はunknownで、idleにならない", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false }) as Response));
    const { result } = renderHook(() => useReleasePreparation("o/a"));
    expect(result.current.prepState).toBe("unknown");
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.prepState).toBe("unknown");
  });

  it("取得後はidle／runningを返し、リポジトリを切り替えるとunknownへ戻る", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        jsonResponse(url.includes("repo=a") ? { failure: null, activeFixSeriesStatuses: ["rebuilding"] } : { failure: null, activeFixSeriesStatuses: [] }),
      ),
    );
    const { result, rerender } = renderHook(({ name }) => useReleasePreparation(name), { initialProps: { name: "o/a" } });
    await waitFor(() => expect(result.current.prepState).toBe("running"));
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    rerender({ name: "o/b" });
    expect(result.current.prepState).toBe("unknown");
  });

  it("遅れて届いた別リポジトリの応答は適用しない", async () => {
    let resolveA: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("repo=a")
          ? new Promise<Response>((resolve) => {
              resolveA = resolve;
            })
          : Promise.resolve(jsonResponse({ failure: null, activeFixSeriesStatuses: [] })),
      ),
    );
    const { result, rerender } = renderHook(({ name }) => useReleasePreparation(name), { initialProps: { name: "o/a" } });
    rerender({ name: "o/b" });
    await waitFor(() => expect(result.current.prepState).toBe("idle"));
    await act(async () => {
      resolveA(jsonResponse({ failure: null, activeFixSeriesStatuses: ["rebuilding"] }));
    });
    expect(result.current.prepState).toBe("idle");
  });
});
