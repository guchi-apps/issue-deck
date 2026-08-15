// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsDialog } from "@/components/dashboard/settings/settings-dialog";

// フックの戻り値は毎レンダー同じ参照を返す（都度 vi.fn() を作ると identity が変わり続け、
// 依存に入れているeffectが再実行され続ける）
const updateAutoRetryLimit = vi.fn().mockResolvedValue(true);
const updateClaudeModel = vi.fn().mockResolvedValue(true);
const updateDispatchConcurrency = vi.fn().mockResolvedValue(true);
const appSettingsMutations = {
  updateAutoRetryLimit,
  updateClaudeModel,
  updateDispatchConcurrency,
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

const onUpdated = vi.fn();

function renderDialog() {
  return render(
    <SettingsDialog
      open
      onOpenChange={() => {}}
      currentUser={{ login: "octocat", name: "Octo Cat", image: null }}
      autoRetryLimit={2}
      claudeModel="auto"
      claudeModelAssist="haiku"
      dispatchConcurrency={2}
      onUpdated={onUpdated}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("SettingsDialog", () => {
  it("4つの区分をタブとして出し、既定では実行設定を開く（#1539）", () => {
    renderDialog();

    for (const label of ["アカウント", "実行設定", "フリート運用", "状態"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.getByLabelText("自動リトライ回数")).toBeTruthy();
    expect(screen.getByLabelText("サブPCの同時実行数")).toBeTruthy();
  });

  it("保存ボタンを持つのは実行設定だけで、即時実行の区分には無い（#1539）", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /フリート運用/ }));

    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.getByRole("button", { name: /Issueを再同期/ })).toBeTruthy();
    expect(screen.getByText("Fine-grained PATの有効期限")).toBeTruthy();
  });

  it("変更が無いあいだ保存は押せず、変更すると押せるようになる", async () => {
    renderDialog();

    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("自動リトライ回数"), { target: { value: "5" } });
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(updateAutoRetryLimit).toHaveBeenCalledWith(5));
    expect(onUpdated).toHaveBeenCalledWith({
      autoRetryLimit: 5,
      claudeModel: "auto",
      claudeModelAssist: "haiku",
      dispatchConcurrency: 2,
    });
  });

  it("状態の区分では使用量と障害状況をまとめて出す（元は別ダイアログだった）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /状態/ }));

    expect(screen.getByText("GitHub API使用量")).toBeTruthy();
    expect(screen.getByText("Claudeプラン使用量")).toBeTruthy();
    expect(screen.getByText("GitHub障害状況")).toBeTruthy();
  });
});
