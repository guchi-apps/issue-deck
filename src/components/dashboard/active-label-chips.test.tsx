// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveLabelChips } from "@/components/dashboard/active-label-chips";

afterEach(() => cleanup());

describe("ActiveLabelChips（#4543）", () => {
  it("選択が無いときは何も描かない", () => {
    const { container } = render(<ActiveLabelChips labels={[]} onRemove={() => {}} onClear={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("選択中のラベルを出し、押すと外せる", () => {
    const onRemove = vi.fn();
    render(<ActiveLabelChips labels={["bug", "docs"]} onRemove={onRemove} onClear={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /bug/ }));
    expect(onRemove).toHaveBeenCalledWith("bug");
  });

  it("複数選択ならまとめて解除できる", () => {
    const onClear = vi.fn();
    render(<ActiveLabelChips labels={["a", "b"]} onRemove={() => {}} onClear={onClear} />);
    fireEvent.click(screen.getByText("すべて解除"));
    expect(onClear).toHaveBeenCalled();
  });
});
