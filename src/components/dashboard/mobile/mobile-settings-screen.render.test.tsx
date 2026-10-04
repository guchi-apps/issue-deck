// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../../../package.json";
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
  claudeUsage: { data: null, isLoading: false, error: null, notConfigured: true },
  codexUsage: { data: null, isLoading: false, error: null, notConfigured: true },
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

const onSetRepositoryHidden = vi.fn();
const onSetRepositoriesHidden = vi.fn();

const repositories = [
  {
    id: "repo-1",
    name: "issue-deck",
    fullName: "guchi-apps/issue-deck",
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    dispatchRunnable: false,
    hidden: false,
    favorite: false,
    excludedFromIssueCreation: false,
    releaseCheckSince: null,
  },
];

function renderScreen() {
  return render(
    <MobileSettingsScreen
      onBack={vi.fn()}
      currentUser={{ login: "octocat", name: "Octo Cat", image: null }}
      autoRetryLimit={2}
      claudeModel="auto"
      claudeModelAssist="haiku"
      claudeLocalModel="sonnet"
      codexModel="auto"
      appAiModel="claude-haiku-4-5"
      appAiModelReasoning="claude-sonnet-5-5"
      modelPickEngine="app-ai"
      dispatchConcurrency={2}
      repositories={repositories}
      onSetRepositoryHidden={onSetRepositoryHidden}
      onSetRepositoriesHidden={onSetRepositoriesHidden}
      onSetRepositoryIssueCreationExcluded={vi.fn()}
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
  it("PCの設定ダイアログと同じ目的別グループを一覧に出す（#3983）", () => {
    renderScreen();

    for (const label of ["一般", "AI・実行", "管理", "情報"]) {
      expect(screen.getByRole("region", { name: label })).toBeTruthy();
    }
    for (const label of ["AI・モデル", "実行", "自動化", "リポジトリ", "フリート", "ストレージ", "システム状態"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    // 「アカウント」は区分に並べず、アカウント名のカードから開く（#3744）
    expect(screen.queryByRole("button", { name: /^アカウント$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "アカウント設定" })).toBeTruthy();
    // 一覧の時点では中身を出さない（ドリルダウン式）
    expect(screen.queryByLabelText("自動リトライ回数")).toBeNull();
  });

  it("バージョンを一覧の最下部に常設し、押すと更新履歴へ入る（#1764）", () => {
    renderScreen();

    const version = screen.getByRole("button", { name: /Issue Deck v/ });
    expect(version.textContent).toContain(`v${packageJson.version}`);

    fireEvent.click(version);
    expect(screen.getByRole("heading", { name: "更新履歴" })).toBeTruthy();
    expect(screen.getByText("使用中")).toBeTruthy();
  });

  it("区分を選ぶと中身へ入り、戻るで一覧へ帰る", () => {
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: /^実行/ }));
    expect(screen.getByLabelText("自動リトライ回数")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.queryByLabelText("自動リトライ回数")).toBeNull();
    expect(screen.getByRole("button", { name: /^フリート/ })).toBeTruthy();
  });

  it("アカウント名を押すとアカウント設定へ入り、戻るで一覧へ帰る（#3744）", () => {
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "アカウント設定" }));
    expect(screen.getByRole("heading", { name: "アカウント" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /ログアウト/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /アカウントを削除/ })).toBeNull();
    // 一覧は重ならない
    expect(screen.queryByRole("button", { name: /^フリート/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(screen.getByRole("button", { name: /^フリート/ })).toBeTruthy();
  });

  it("一覧ではモーダルを閉じるボタンが出て、押すとonBackを呼ぶ（#3744）", () => {
    const onBack = vi.fn();
    render(
      <MobileSettingsScreen
        onBack={onBack}
        currentUser={{ login: "octocat", name: "Octo Cat", image: null }}
        autoRetryLimit={2}
        claudeModel="auto"
        claudeModelAssist="haiku"
        claudeLocalModel="sonnet"
        codexModel="auto"
        appAiModel="claude-haiku-4-5"
        appAiModelReasoning="claude-sonnet-5-5"
        modelPickEngine="app-ai"
        dispatchConcurrency={2}
        repositories={repositories}
        onSetRepositoryHidden={onSetRepositoryHidden}
        onSetRepositoriesHidden={onSetRepositoriesHidden}
        onSetRepositoryIssueCreationExcluded={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("リポジトリの区分でもPCと同じリポジトリ一覧を出す（#3983）", () => {
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: /^リポジトリ/ }));

    expect(screen.getByText(/1件中/).textContent).toBe("1件中1件を表示中");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(onSetRepositoryHidden).toHaveBeenCalledWith(repositories[0], true);
  });
});
