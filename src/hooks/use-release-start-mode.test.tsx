// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReleaseStartModes } from "@/lib/release-request";
const mocks = vi.hoisted(() => ({ fetchModes: vi.fn() }));
vi.mock("@/lib/release-request", () => ({ fetchReleaseStartModes: mocks.fetchModes }));
import { useReleaseStartMode } from "@/hooks/use-release-start-mode";
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("再確認中は古い開始判定を外し、応答後に新状態を出す", async () => {
  mocks.fetchModes.mockResolvedValueOnce({ "o/r": { mode: "candidate" } });
  let resolve!: (modes: ReleaseStartModes) => void;
  mocks.fetchModes.mockImplementationOnce(() => new Promise<ReleaseStartModes>((done) => { resolve = done; }));
  const { result, rerender } = renderHook(({ key }) => useReleaseStartMode("o/r", true, key), { initialProps: { key: 0 } });
  await waitFor(() => expect(result.current?.mode).toBe("candidate"));
  rerender({ key: 1 });
  expect(result.current).toBeNull();
  await act(async () => resolve({ "o/r": { mode: "unknown", label: "取得不能" } }));
  expect(result.current).toEqual({ mode: "unknown", label: "取得不能" });
});
