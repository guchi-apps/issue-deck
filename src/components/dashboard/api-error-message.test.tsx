// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { GITHUB_REAUTH_REQUIRED_MESSAGE } from "@/lib/github/reauth-message";

const startGithubOAuth = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

vi.mock("@/lib/supabase/github-oauth", () => ({
  get startGithubOAuth() {
    return startGithubOAuth;
  },
}));

describe("ApiErrorMessage", () => {
  afterEach(() => {
    cleanup();
    startGithubOAuth.mockClear();
  });

  it("messageがnullの場合は何も表示しない", () => {
    const { container } = render(<ApiErrorMessage message={null} />);

    expect(container.firstChild).toBeNull();
  });

  it("通常のエラーメッセージでは再ログインボタンを表示しない", () => {
    render(<ApiErrorMessage message="リクエストに失敗しました (500)" />);

    expect(screen.getByText("リクエストに失敗しました (500)")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "GitHubに再ログイン" })).toBeNull();
  });

  it("GitHub再ログインが必要なメッセージでは再ログインボタンを表示し、押下でOAuthを開始する", () => {
    render(<ApiErrorMessage message={GITHUB_REAUTH_REQUIRED_MESSAGE} />);

    const button = screen.getByRole("button", { name: "GitHubに再ログイン" });
    fireEvent.click(button);

    expect(startGithubOAuth).toHaveBeenCalledWith("/dashboard");
  });
});
