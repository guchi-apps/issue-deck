// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseBumpKindSelect } from "@/components/dashboard/release-bump-kind-select";
import type { BumpKind } from "@/lib/semver-bump";

afterEach(cleanup);

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<BumpKind | null>(null);
  return (
    <>
      <output data-testid="value">v:{value ?? "auto"}</output>
      <ReleaseBumpKindSelect value={value} onChange={setValue} currentVersion="3.21.0" disabled={disabled} />
    </>
  );
}

describe("ReleaseBumpKindSelect", () => {
  it("初期は「手動で変える」だけが見える", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "手動で変える" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByText("自動判定に戻す")).toBeNull();
  });

  it("展開すると3択と目安が出て、選択と「自動判定に戻す」で値が変わる", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "手動で変える" }));
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByText("→ 3.22.0")).toBeTruthy();

    fireEvent.click(screen.getByText("major"));
    expect(screen.getByTestId("value").textContent).toBe("v:major");
    expect(screen.getByText("major").closest("[role='radio']")?.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByText("自動判定に戻す"));
    expect(screen.getByTestId("value").textContent).toBe("v:auto");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("起動中は展開できない", () => {
    render(<Harness disabled />);
    expect(screen.getByRole("button", { name: "手動で変える" }).hasAttribute("disabled")).toBe(true);
  });
});
