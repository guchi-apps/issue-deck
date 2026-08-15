// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MobileSettingsScreen } from "@/components/dashboard/mobile/mobile-settings-screen";

const appSettingsMutations = {
  updateAutoRetryLimit: vi.fn().mockResolvedValue(true),
  updateClaudeModel: vi.fn().mockResolvedValue(true),
  updateDispatchConcurrency: vi.fn().mockResolvedValue(true),
  isSubmitting: false,
  error: null,
  setError: vi.fn(),
};

const settingsData = {
  rateLimits: { data: null, isLoading: false, error: null },
  apiUsage: { data: null, isLoading: false, error: null },
  claudeUsage: { data: null, isLoading: false, error: null, notConfigured: true },
  githubStatus: { data: null, isLoading: false, error: null },
  fineGrainedTokens: { data: [], isLoading: false, error: null, refetch: vi.fn() },
  hasExpiringFineGrainedToken: false,
  hasGithubIncident: false,
};

vi.mock("@/hooks/use-settings-data", () => ({
  useSettingsData: () => settingsData,
}));

vi.mock("@/hooks/use-app-settings-mutations", () => ({
  useAppSettingsMutations: () => appSettingsMutations,
}));

vi.mock("@/hooks/use-issue-sync", () => ({
  useIssueSync: () => ({ isSyncing: false, handleSync: vi.fn() }),
}));

vi.mock("@/hooks/use-repository-sync", () => ({
  useRepositorySync: () => ({ isSyncing: false, handleSync: vi.fn() }),
}));

vi.mock("@/hooks/use-workflow-tags", () => ({
  useWorkflowTags: () => ({ overview: null, isLoading: false, error: null, reload: vi.fn() }),
}));

vi.mock("@/hooks/use-secrets-sync", () => ({
  useSecretsSync: () => ({ repositories: [], isLoading: false, error: null, reload: vi.fn() }),
}));

vi.mock("@/hooks/use-fine-grained-token-mutations", () => ({
  useFineGrainedTokenMutations: () => ({
    createFineGrainedToken: vi.fn(),
    deleteFineGrainedToken: vi.fn(),
    isSubmitting: false,
    error: null,
    setError: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-account-actions", () => ({
  useAccountActions: () => ({ handleLogout: vi.fn(), handleDeleteAccount: vi.fn() }),
}));

function renderScreen() {
  return render(
    <MobileSettingsScreen
      currentUser={{ login: "octocat", name: "Octo Cat", image: null }}
      autoRetryLimit={2}
      claudeModel="auto"
      claudeModelAssist="haiku"
      dispatchConcurrency={2}
      onUpdated={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("MobileSettingsScreen", () => {
  it("PCの設定ダイアログと同じ4区分を一覧に出す（#1539）", () => {
    renderScreen();

    for (const label of ["アカウント", "実行設定", "フリート運用", "状態"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    // 一覧の時点では中身を出さない（ドリルダウン式）
    expect(screen.queryByLabelText("自動リトライ回数")).toBeNull();
  });

  it("区分を選ぶと中身へ入り、戻るで一覧へ帰る", () => {
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: /実行設定/ }));
    expect(screen.getByLabelText("自動リトライ回数")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.queryByLabelText("自動リトライ回数")).toBeNull();
    expect(screen.getByRole("button", { name: /フリート運用/ })).toBeTruthy();
  });
});
