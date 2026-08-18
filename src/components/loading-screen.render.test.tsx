// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppLoadingScreen, LoadingStatusPill } from "@/components/loading-screen";
import { SLOW_LOADING_THRESHOLD_MS } from "@/lib/loading-screen-message";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AppLoadingScreen", () => {
  it("読み込み中はアプリ名と状態だけを出し、操作は出さない", () => {
    render(<AppLoadingScreen />);

    expect(screen.getByText("IssueDeck")).toBeDefined();
    expect(screen.getByText("読み込み中")).toBeDefined();
    expect(screen.queryByRole("button", { name: "再読み込み" })).toBeNull();
  });

  it("しきい値を過ぎたら文言を強め、再読み込みを出す", () => {
    vi.useFakeTimers();
    render(<AppLoadingScreen />);

    act(() => {
      vi.advanceTimersByTime(SLOW_LOADING_THRESHOLD_MS);
    });

    expect(screen.getByText("時間がかかっています")).toBeDefined();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeDefined();
  });
});

describe("LoadingStatusPill", () => {
  it("スケルトンに重ねる帯も同じしきい値で切り替わる", () => {
    vi.useFakeTimers();
    render(<LoadingStatusPill />);

    expect(screen.getByText("読み込み中")).toBeDefined();
    expect(screen.queryByRole("button", { name: "再読み込み" })).toBeNull();

    act(() => {
      vi.advanceTimersByTime(SLOW_LOADING_THRESHOLD_MS);
    });

    expect(screen.getByText("時間がかかっています")).toBeDefined();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeDefined();
  });
});
