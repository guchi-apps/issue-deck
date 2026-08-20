// @vitest-environment jsdom
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Boxes } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LazyFleetPanel } from "@/components/dashboard/settings/lazy-fleet-panel";

/**
 * 「フリート運用」の各区画を、押すまで読み込まないカードにする（#2022）。
 *
 * ここで確かめるのは**中身をいつマウントするか**。中のセクションは自分がマウントされた
 * 時点でGitHubを叩き始めるため、マウントの回数がそのまま通信の回数になる。
 */
const onMount = vi.fn();

function Child() {
  useEffect(() => {
    onMount();
  }, []);
  return <p>中身の内容</p>;
}

function renderPanel() {
  return render(
    <LazyFleetPanel
      icon={Boxes}
      title="共有ワークフローの配布"
      description="参照タグの更新と、自動修復ワークフローの配布"
      loadHint="開くと各リポジトリの参照状況をGitHubから取得します"
    >
      <Child />
    </LazyFleetPanel>,
  );
}

afterEach(() => {
  cleanup();
  onMount.mockClear();
});

describe("LazyFleetPanel", () => {
  it("開くまで中身をマウントしない（開いた時点で初めて読み込む）", () => {
    renderPanel();

    expect(screen.getByText("共有ワークフローの配布")).toBeTruthy();
    expect(screen.queryByText("中身の内容")).toBeNull();
    expect(onMount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /開く/ }));

    expect(screen.getByText("中身の内容")).toBeTruthy();
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it("閉じても中身をアンマウントしない（開き直しで同じ取得を繰り返さない）", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /開く/ }));
    fireEvent.click(screen.getByRole("button", { name: /閉じる/ }));
    fireEvent.click(screen.getByRole("button", { name: /開く/ }));

    expect(screen.getByText("中身の内容")).toBeTruthy();
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it("開く前の案内（何を取りに行くか）は、開いたら消す", () => {
    renderPanel();

    expect(screen.getByText("開くと各リポジトリの参照状況をGitHubから取得します")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /開く/ }));

    expect(screen.queryByText("開くと各リポジトリの参照状況をGitHubから取得します")).toBeNull();
  });
});
