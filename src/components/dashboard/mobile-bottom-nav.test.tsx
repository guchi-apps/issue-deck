// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MobileBottomNav,
  MobileBottomNavView,
} from "@/components/dashboard/mobile-bottom-nav";

afterEach(() => {
  cleanup();
});

describe("MobileBottomNav（#1638でブランチと設定を入れ替え、#2631でAI使用量を足し、#2724でIssueとPRを外し、#2811でリリースを足した）", () => {
  it("フッターはホーム・ブランチ・リリース・AI使用量の4つで、設定は出さない", () => {
    render(<MobileBottomNav active="home" onSelect={vi.fn()} />);

    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["ホーム", "ブランチ", "リリース", "AI使用量"]);
  });

  // ラベルは画面名（「リリース履歴」）ではなく「リリース」（#2811）。1枠98pxに6文字は
  // 収まらず、隣の枠と接する
  it("「リリース」タブを押すとリリース履歴画面のidを返す", () => {
    const onSelect = vi.fn();
    render(<MobileBottomNav active="home" onSelect={onSelect} />);

    screen.getByRole("button", { name: "リリース" }).click();
    expect(onSelect).toHaveBeenCalledWith("release-history");
  });

  // 外した2つはホームのメニューから開く（`mobile-home-screen.tsx`）。ここへ戻すと、
  // 同じ画面への入口が2か所に増える
  it("「Issue」「PR」のタブは出さない（#2724）", () => {
    render(<MobileBottomNav active="home" onSelect={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Issue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "PR" })).toBeNull();
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

  it("Providerの外では反映待ちの件数を出さない（未取得と同じ扱い）", () => {
    render(<MobileBottomNav active="home" onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "ブランチ" }).textContent).toBe("ブランチ");
  });
});

describe("MobileBottomNavViewの反映待ちバッジ（#2055）", () => {
  it("ブランチタブに合計を出し、内訳はaria-labelで読める", () => {
    render(
      <MobileBottomNavView
        active="home"
        onSelect={vi.fn()}
        mergePending={{ develop: 1, main: 2, total: 3, hasError: false }}
      />,
    );

    const branchTab = screen.getByRole("button", {
      name: "ブランチ（developへマージ待ち1件・mainへマージ待ち2件）",
    });
    expect(branchTab.textContent).toContain("3");
    // 他のタブには付けない
    expect(screen.getByRole("button", { name: "AI使用量" }).textContent).toBe("AI使用量");
  });

  it("未取得（null）・0件のときは数字を出さない", () => {
    const { rerender } = render(
      <MobileBottomNavView active="home" onSelect={vi.fn()} mergePending={null} />,
    );
    expect(screen.getByRole("button", { name: "ブランチ" }).textContent).toBe("ブランチ");

    rerender(
      <MobileBottomNavView
        active="home"
        onSelect={vi.fn()}
        mergePending={{ develop: 0, main: 0, total: 0, hasError: false }}
      />,
    );
    expect(screen.getByRole("button", { name: "ブランチ" }).textContent).toBe("ブランチ");
  });

  it("チェックが落ちているときはバッジを赤にする", () => {
    render(
      <MobileBottomNavView
        active="home"
        onSelect={vi.fn()}
        mergePending={{ develop: 0, main: 1, total: 1, hasError: true }}
      />,
    );

    const badge = screen.getByText("1");
    expect(badge.className).toContain("bg-destructive");
    expect(badge.className).not.toContain("bg-amber-500");
  });
});
