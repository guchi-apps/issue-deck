// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useReleaseTriggerPending } from "@/hooks/use-release-trigger-pending";

const REPO = "guchi-apps/issue-deck";
const KEY = `issue-deck:release-triggered-at:${REPO}`;

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("useReleaseTriggerPending（#1955）", () => {
  it("押していなければ起動中ではなく、時計も回さない", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");

    const { result } = renderHook(() => useReleaseTriggerPending(REPO));

    expect(result.current.isPending).toBe(false);
    // この画面はリポジトリの数だけこのhookを常時マウントするため、
    // 起動していない普段の状態で全件のタイマーが回らないことを担保する
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("押した時点から起動中になり、経過を見るための時計が回り出す", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");

    const { result } = renderHook(() => useReleaseTriggerPending(REPO));
    act(() => result.current.markTriggered());

    expect(result.current.isPending).toBe(true);
    expect(setInterval).toHaveBeenCalled();
    // 端末に残すので、画面を開き直しても起動中のまま
    expect(window.localStorage.getItem(KEY)).toBeTruthy();
  });

  it("失効した起動時刻は起動中として扱わない", () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    window.localStorage.setItem(KEY, JSON.stringify(longAgo));

    const { result } = renderHook(() => useReleaseTriggerPending(REPO));

    expect(result.current.isPending).toBe(false);
  });
});
