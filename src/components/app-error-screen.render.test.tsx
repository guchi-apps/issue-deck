// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppErrorScreen } from "@/components/app-error-screen";

afterEach(cleanup);

describe("AppErrorScreen", () => {
  it("読み込めなかったことと、次にできる操作を日本語で出す", () => {
    render(<AppErrorScreen onRetry={() => {}} />);

    expect(screen.getByText("読み込めませんでした")).toBeDefined();
    expect(screen.getByRole("button", { name: "再試行" })).toBeDefined();
    expect(screen.getByRole("button", { name: "ログイン画面へ" })).toBeDefined();
  });

  it("再試行は渡された復帰処理（error.tsxのreset）を呼ぶ", () => {
    const onRetry = vi.fn();
    render(<AppErrorScreen onRetry={onRetry} />);

    screen.getByRole("button", { name: "再試行" }).click();

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("原因を追う手がかりとしてdigestを出す", () => {
    render(<AppErrorScreen digest="71954104" onRetry={() => {}} />);

    expect(screen.getByText("71954104")).toBeDefined();
  });
});
