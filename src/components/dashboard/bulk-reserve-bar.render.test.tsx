// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BulkReserveDock } from "@/components/dashboard/bulk-reserve-bar";

/** 一括予約の登録バーのモデル選択（#3415）。選んだモデルが親へ渡ることを見る */

afterEach(cleanup);

function renderDock(onModelChange: (model: unknown) => void) {
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
  it("プルダウンで、未選択のときは「設定に従う」が出る", () => {
    renderDock(vi.fn());
    expect(screen.getByRole("combobox", { name: "使用モデル" }).textContent).toContain("設定に従う");
  });
});
