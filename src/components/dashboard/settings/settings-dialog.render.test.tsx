// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../../../package.json";
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
  actionsUsage: { data: null, isLoading: false, error: null, notConfigured: false },
  claudeUsage: { data: null, isLoading: false, error: null, notConfigured: true },
  claudeApiUsage: { data: null, isLoading: false, error: null },
  githubStatus: { data: null, isLoading: false, error: null },
  fineGrainedTokens: { data: [], isLoading: false, error: null, refetch: vi.fn() },
  hasExpiringFineGrainedToken: false,
  hasGithubIncident: false,
};

// 「状態」区分を開いているあいだだけ使用量を取りに行く（#2022）。引数を控えて検証する
const useSettingsDataArgs: [boolean, boolean][] = [];
vi.mock("@/hooks/use-settings-data", () => ({
  useSettingsData: (enabled: boolean, statusActive: boolean) => {
    useSettingsDataArgs.push([enabled, statusActive]);
    return settingsData;
  },
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
  },
  {
    id: "repo-2",
    name: "car-care",
    fullName: "guchi-apps/car-care",
    private: true,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: false,
    dispatchRunnable: false,
    hidden: true,
    favorite: false,
  },
];

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
      repositories={repositories}
      onSetRepositoryHidden={onSetRepositoryHidden}
      onSetRepositoriesHidden={onSetRepositoriesHidden}
      onUpdated={onUpdated}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  useSettingsDataArgs.length = 0;
  cleanup();
});

describe("SettingsDialog", () => {
  it("区分をタブとして出し、既定では実行設定を開く（#1539・#1552）", () => {
    renderDialog();

    for (const label of ["アカウント", "表示", "実行設定", "フリート運用", "状態", "更新履歴"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.getByLabelText("自動リトライ回数")).toBeTruthy();
    expect(screen.getByLabelText("サブPCの同時実行数")).toBeTruthy();
  });

  it("バージョンはアカウントを開かなくても見え、押すと更新履歴が開く（#1764）", () => {
    renderDialog();

    // 既定は実行設定。区分を切り替えてもバージョンは左タブの最下部に出たまま。
    const version = screen.getByRole("button", { name: /Issue Deck v/ });
    expect(version.textContent).toContain(`v${packageJson.version}`);

    fireEvent.click(screen.getByRole("button", { name: /フリート運用/ }));
    expect(screen.getByRole("button", { name: /Issue Deck v/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Issue Deck v/ }));
    expect(screen.getByText("これまでの更新内容")).toBeTruthy();
    // 更新履歴の先頭は現行バージョンで、「使用中」の印が付く
    expect(screen.getByText("使用中")).toBeTruthy();
    expect(screen.getByRole("heading", { name: `v${packageJson.version}` })).toBeTruthy();
  });

  it("保存ボタンを持つのは実行設定だけで、即時実行の区分には無い（#1539）", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /フリート運用/ }));

    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.getByRole("button", { name: /Issueを再同期/ })).toBeTruthy();
    expect(screen.getByText("Fine-grained PATの有効期限")).toBeTruthy();
  });

  it("フリート運用の各区画は畳んであり、開いた区画だけを読み込む（#2022）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /フリート運用/ }));

    // 見出しは出るが、中身（＝取得を伴う一覧）はまだ無い
    expect(screen.getByText("1Password → GitHub のシークレット同期")).toBeTruthy();
    expect(screen.queryByLabelText(/対象キー/)).toBeNull();

    const panel = screen
      .getByText("1Password → GitHub のシークレット同期")
      .closest("section") as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: /開く/ }));

    expect(screen.getByLabelText(/対象キー/)).toBeTruthy();
  });

  it("使用量・レート制限は「状態」を開くまで取りに行かない（#2022）", () => {
    renderDialog();

    // 開いた直後はどの区分も「状態」ではない
    expect(useSettingsDataArgs.every(([, statusActive]) => statusActive === false)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /状態/ }));

    expect(useSettingsDataArgs.at(-1)).toEqual([true, true]);
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

  it("表示の区分でチェックを外すと、そのリポジトリを非表示にする（#1552）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /表示/ }));

    expect(screen.getByText(/2件中/).textContent).toBe("2件中1件を表示中");

    const checkboxes = screen.getAllByRole("checkbox");
    // チェックが入っている＝表示中。1件目（issue-deck）は表示、2件目（car-care）は非表示。
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true");
    expect(checkboxes[1].getAttribute("aria-checked")).toBe("false");

    fireEvent.click(checkboxes[0]);
    expect(onSetRepositoryHidden).toHaveBeenCalledWith(repositories[0], true);
  });

  it("表示の区分は行のどこを押しても切り替わり、二重に切り替わらない（#1552）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /表示/ }));

    // チェックボックスそのものではなくリポジトリ名を押す
    fireEvent.click(screen.getByText("issue-deck"));
    expect(onSetRepositoryHidden).toHaveBeenCalledTimes(1);
    expect(onSetRepositoryHidden).toHaveBeenCalledWith(repositories[0], true);

    // チェックボックスを押したときも1回だけ（行のクリックへ伝播させない）
    onSetRepositoryHidden.mockClear();
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(onSetRepositoryHidden).toHaveBeenCalledTimes(1);
    expect(onSetRepositoryHidden).toHaveBeenCalledWith(repositories[1], false);
  });

  it("表示の区分の一括操作は、状態が変わる行だけを渡す（#1552）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /表示/ }));

    fireEvent.click(screen.getByRole("button", { name: "すべて表示" }));
    expect(onSetRepositoriesHidden).toHaveBeenCalledWith([repositories[1]], false);

    fireEvent.click(screen.getByRole("button", { name: "すべて非表示" }));
    expect(onSetRepositoriesHidden).toHaveBeenCalledWith([repositories[0]], true);
  });

  it("状態の区分では使用量と障害状況をまとめて出す（元は別ダイアログだった）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /状態/ }));

    expect(screen.getByText("GitHub使用量")).toBeTruthy();
    expect(screen.getByText("AI使用量")).toBeTruthy();
    expect(screen.getByText("GitHub障害状況")).toBeTruthy();
  });
});
