// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileReloadButton } from "@/components/dashboard/mobile/mobile-reload-button";

afterEach(() => {
  cleanup();
});

describe("MobileReloadButton", () => {
  it("押すとリロードが実行される", () => {
    const onReload = vi.fn();
    render(<MobileReloadButton onReload={onReload} />);

    fireEvent.click(screen.getByRole("button", { name: "画面を更新" }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("連続で押してもリロードは1回しか走らない", () => {
    const onReload = vi.fn();
    render(<MobileReloadButton onReload={onReload} />);

    const button = screen.getByRole("button", { name: "画面を更新" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
