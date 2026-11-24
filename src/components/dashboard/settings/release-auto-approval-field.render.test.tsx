// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseAutoApprovalField } from "@/components/dashboard/settings/release-auto-approval-field";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReleaseAutoApprovalField", () => {
  it("現在の設定を読み込み、切り替えた時点で保存する", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? new Response(JSON.stringify({ enabled: true }), { status: 200 })
        : new Response(JSON.stringify({ enabled: false }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ReleaseAutoApprovalField />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[0]).toBe("/api/settings/release-auto-approval");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ enabled: true });
  });

  it("保存に失敗したら元の状態へ戻し、理由を出す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PATCH" ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ enabled: false }), { status: 200 }),
      ),
    );
    render(<ReleaseAutoApprovalField />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    await screen.findByText(/保存できませんでした/);
    expect(box.checked).toBe(false);
  });
});
