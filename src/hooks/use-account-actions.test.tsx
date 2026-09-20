// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAccountActions } from "@/hooks/use-account-actions";

const push = vi.fn();
const refresh = vi.fn();
const signOut = vi.fn(async () => ({ error: null }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut } }),
}));

describe("useAccountActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("通常ログアウトは現在のSupabaseセッションだけを破棄する", async () => {
    const { result } = renderHook(() => useAccountActions());

    await act(() => result.current.handleLogout());

    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(push).toHaveBeenCalledWith("/login");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("アカウント削除はAPIで利用者を削除してから全セッションを破棄する", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAccountActions());

    await act(() => result.current.handleDeleteAccount());

    expect(fetchMock).toHaveBeenCalledWith("/api/account", { method: "DELETE" });
    expect(signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(push).toHaveBeenCalledWith("/login");
    expect(refresh).toHaveBeenCalledOnce();
  });
});
