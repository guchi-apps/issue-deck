// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileBottomNav } from "@/components/dashboard/mobile-bottom-nav";

afterEach(() => {
  cleanup();
});

describe("MobileBottomNav（#1638でブランチと設定を入れ替えた）", () => {
  it("フッターはホーム・Issue・PR・ブランチの4つで、設定は出さない", () => {
    render(<MobileBottomNav active="home" onSelect={vi.fn()} />);

    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["ホーム", "Issue", "PR", "ブランチ"]);
  });

  it("activeがnullのときはどのタブも点灯させない（設定画面）", () => {
    render(<MobileBottomNav active={null} onSelect={vi.fn()} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button.className).not.toContain("text-foreground");
    }
  });

  it("押したタブのidを返す", () => {
    const onSelect = vi.fn();
    render(<MobileBottomNav active="home" onSelect={onSelect} />);

    screen.getByRole("button", { name: "ブランチ" }).click();
    expect(onSelect).toHaveBeenCalledWith("flow");
  });
});
