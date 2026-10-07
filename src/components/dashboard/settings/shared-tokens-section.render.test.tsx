// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SharedTokensSection } from "@/components/dashboard/settings/shared-tokens-section";
import type { SharedToken } from "@/types/shared-token";

const deleteSharedToken = vi.fn().mockResolvedValue(true);
const mutations = {
  createSharedToken: vi.fn().mockResolvedValue({ generatedValue: "generated-once" }),
  revealSharedToken: vi.fn().mockResolvedValue(null),
  deleteSharedToken,
  isSubmitting: false,
  error: null,
};

vi.mock("@/hooks/use-shared-tokens", () => ({
  useSharedTokenMutations: () => mutations,
}));

const token: SharedToken = {
  id: "t1",
  name: "EXTERNAL_API_TOKEN",
  description: null,
  sourceReference: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  lastUsedAt: null,
  consumers: [],
};

function renderSection() {
  return render(<SharedTokensSection data={[token]} isLoading={false} error={null} onChanged={vi.fn()} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SharedTokensSection", () => {
  it("削除アイコンを押しても確認前は削除せず、確認ダイアログを出す", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "EXTERNAL_API_TOKENを削除" }));
    expect(screen.getByText("トークンを削除しますか？")).toBeTruthy();
    expect(deleteSharedToken).not.toHaveBeenCalled();
  });

  it("キャンセルでは削除しない", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "EXTERNAL_API_TOKENを削除" }));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByText("トークンを削除しますか？")).toBeNull());
    expect(deleteSharedToken).not.toHaveBeenCalled();
  });

  it("「削除する」で初めて削除する", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "EXTERNAL_API_TOKENを削除" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(deleteSharedToken).toHaveBeenCalledWith("t1"));
  });

  it("値を空欄のまま登録すると値なしで送り、生成された値を1回表示する", async () => {
    renderSection();
    fireEvent.change(screen.getByLabelText("トークン名"), { target: { value: "NEW_TOKEN" } });
    fireEvent.click(screen.getByRole("button", { name: "登録（値を自動生成）" }));
    await waitFor(() =>
      expect(mutations.createSharedToken).toHaveBeenCalledWith({
        name: "NEW_TOKEN",
        value: null,
        description: null,
        sourceReference: null,
      }),
    );
    expect((await screen.findByLabelText("自動生成した値") as HTMLInputElement).value).toBe("generated-once");
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByLabelText("自動生成した値")).toBeNull();
  });
});
