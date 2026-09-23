// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BulkReserveDock } from "@/components/dashboard/bulk-reserve-bar";

/** 一括予約の登録バーのモデル選択（#3415）。選んだモデルが親へ渡ることを見る */

afterEach(cleanup);

function renderDock(onModelChange: (model: string | null) => void) {
  render(
    <BulkReserveDock
      active
      selectedCount={3}
      selectableCount={4}
      hostNames={["subpc"]}
      progress={null}
      summary={null}
      model={null}
      onModelChange={onModelChange}
      onSelectAll={() => {}}
      onClear={() => {}}
      onSubmit={() => {}}
      onDismissSummary={() => {}}
    />,
  );
}

describe("BulkReserveDock のモデル選択", () => {
  it("既定は「設定に従う」で、3つのモデルを選べる", () => {
    const onModelChange = vi.fn();
    renderDock(onModelChange);
    expect(screen.getByRole("radio", { name: "設定に従う" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Opus/ }));
    expect(onModelChange).toHaveBeenCalledWith("opus");
  });
});
