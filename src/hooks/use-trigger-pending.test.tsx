// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readTriggeredAt, useTriggerPending } from "@/hooks/use-trigger-pending";

const REPO = "guchi-apps/issue-deck";
const KEY = `issue-deck:release-triggered-at:${REPO}`;
const DEPLOY_KEY = `issue-deck:deploy-triggered-at:${REPO}`;

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("useTriggerPending（#1955・#2020）", () => {
  it("押していなければ起動中ではなく、時計も回さない", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");

    const { result } = renderHook(() => useTriggerPending("release", REPO));

    expect(result.current.isPending).toBe(false);
    // この画面はリポジトリの数だけこのhookを常時マウントするため、
    // 起動していない普段の状態で全件のタイマーが回らないことを担保する
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("押した時点から起動中になり、経過を見るための時計が回り出す", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");

    const { result } = renderHook(() => useTriggerPending("release", REPO));
    act(() => result.current.markTriggered());

    expect(result.current.isPending).toBe(true);
    expect(setInterval).toHaveBeenCalled();
    // 端末に残すので、画面を開き直しても起動中のまま
    expect(window.localStorage.getItem(KEY)).toBeTruthy();
  });

  it("失効した起動時刻は起動中として扱わない", () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    window.localStorage.setItem(KEY, JSON.stringify(longAgo));

    const { result } = renderHook(() => useTriggerPending("release", REPO));

    expect(result.current.isPending).toBe(false);
  });

  // 種類ごとに別のキーで持つ（#2020）。リリースの起動中が本番デプロイのボタンを止めない
  it("リリースと本番デプロイは別の記録として持つ", () => {
    const { result: release } = renderHook(() => useTriggerPending("release", REPO));
    const { result: deploy } = renderHook(() => useTriggerPending("deploy", REPO));

    act(() => deploy.current.markTriggered());

    expect(deploy.current.isPending).toBe(true);
    expect(release.current.isPending).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe("null");
    expect(window.localStorage.getItem(DEPLOY_KEY)).toBeTruthy();
  });

  // ポーリングの継続判定（`use-deploy-status.ts`）がhookの外から読むため
  it("readTriggeredAtで起動時刻をhookの外からも読める", () => {
    expect(readTriggeredAt("deploy", REPO)).toBeNull();

    const { result } = renderHook(() => useTriggerPending("deploy", REPO));
    act(() => result.current.markTriggered());

    expect(readTriggeredAt("deploy", REPO)).toMatch(/^\d{4}-/);
  });
});
