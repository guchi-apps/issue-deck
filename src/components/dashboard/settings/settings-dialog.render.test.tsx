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
  claudeUsage: { data: null, isLoading: false, error: null, notConfigured: true },
  codexUsage: { data: null, isLoading: false, error: null, notConfigured: true },
  githubStatus: { data: null, isLoading: false, error: null },
  fineGrainedTokens: { data: [], isLoading: false, error: null, refetch: vi.fn() },
  sharedTokens: { data: [], isLoading: false, error: null, refetch: vi.fn() },
  hasExpiringFineGrainedToken: false,
  hasGithubIncident: false,
};

vi.mock("@/hooks/use-settings-data", () => ({
  useSettingsData: () => {
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
const onSetRepositoryIssueCreationExcluded = vi.fn();

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
    excludedFromIssueCreation: false,
    releaseCheckSince: null,
  },
];

// 区分を切り替えても入力中の値を失わないよう、設定の区分は`hidden`で隠すだけでマウントしたままにしている。
// 非表示の区分に属する要素は「画面に出ていない」ものとして扱う。
function isShown(element: Element | null): boolean {
  return element !== null && element.closest("[hidden]") === null;
}

function renderDialog() {
  return render(
    <SettingsDialog
      open
      onOpenChange={() => {}}
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
      onSetRepositoryIssueCreationExcluded={onSetRepositoryIssueCreationExcluded}
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
  it("目的別のグループと区分を出し、既定ではAI・モデルを開く（#3983）", () => {
    renderDialog();

    for (const label of ["一般", "AI・実行", "管理", "情報"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const label of ["AI・モデル", "実行", "自動化", "リポジトリ", "フリート", "ストレージ", "システム状態"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}$`) })).toBeTruthy();
    }
    // 「アカウント」は区分に並べず、アカウント名の行から開く（#3744）
    expect(screen.queryByRole("button", { name: /^アカウント$/ })).toBeNull();
    expect(screen.getByRole("group", { name: "AI実行プロバイダー" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Claudeを選んだときの各工程" })).toBeTruthy();
    expect(isShown(screen.queryByLabelText("自動リトライ回数"))).toBe(false);
  });

  it("アカウント名の行を押すとアカウント設定が開き、削除ボタンは無い（#3744）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "アカウント設定" }));

    expect(screen.getByRole("button", { name: /ログアウト/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /アカウントを削除/ })).toBeNull();
    expect(isShown(screen.queryByLabelText("自動リトライ回数"))).toBe(false);
  });

  it("バージョンはアカウントを開かなくても見え、押すと更新履歴が開く（#1764）", () => {
    renderDialog();

    // 既定はAI・モデル。区分を切り替えてもバージョンは左タブの最下部に出たまま。
    const version = screen.getByRole("button", { name: /Issue Deck v/ });
    expect(version.textContent).toContain(`v${packageJson.version}`);

    fireEvent.click(screen.getByRole("button", { name: /^フリート$/ }));
    expect(screen.getByRole("button", { name: /Issue Deck v/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Issue Deck v/ }));
    expect(screen.getByText("これまでの更新内容")).toBeTruthy();
    // 更新履歴の先頭のエントリに「使用中」の印が付く（画面で使える変化が無いリリースでは
    // 現行バージョンぴったりのエントリが無いことがあるため、先頭＝直近の実体あるエントリで
    // 判定する。#3282）
    const badge = screen.getByText("使用中");
    const section = badge.closest("section");
    expect(section).not.toBeNull();
    expect(within(section!).getByRole("heading", { name: /^v\d+\.\d+\.\d+$/ })).toBeTruthy();
  });

  it("実行と自動化は区分ごとに自分の保存ボタンを持ち、即時保存の項目も自動化に並ぶ（#3983）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^実行$/ }));
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
    expect(isShown(screen.getByLabelText("自動リトライ回数"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^自動化$/ }));

    // 計画レビューのエージェント設定は保存を押すまで効かないため、自動化にも専用の保存ボタンがある。
    // 実行区分のフォームは隠れ、表示中の保存ボタンは自動化のものだけになる。
    expect(isShown(screen.getByLabelText("自動リトライ回数"))).toBe(false);
    expect(isShown(screen.getByRole("button", { name: "保存" }))).toBe(true);
    expect(screen.getByLabelText("リリース準備の自動実行間隔")).toBeTruthy();
  });

  it("フリートの各区画は畳んであり、開いた区画だけを読み込む（#2022）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^フリート$/ }));

    // 見出しは出るが、中身（＝取得を伴う一覧）はまだ無い
    expect(screen.getByText("1Password → GitHub のシークレット同期")).toBeTruthy();
    expect(screen.queryByLabelText(/対象キー/)).toBeNull();

    const panel = screen
      .getByText("1Password → GitHub のシークレット同期")
      .closest("section") as HTMLElement;
    fireEvent.click(within(panel).getByRole("button", { name: /開く/ }));

    expect(screen.getByLabelText(/対象キー/)).toBeTruthy();
  });

  it("変更が無いあいだ保存は押せず、変更すると押せるようになる", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^実行$/ }));

    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("自動リトライ回数"), { target: { value: "5" } });
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(updateAutoRetryLimit).toHaveBeenCalledWith(5));
    // 実行の区分は、自分が持つ設定（既定エージェント・フェイルオーバー）だけを保存する
    expect(updateClaudeModel).toHaveBeenCalledWith({
      defaultDispatchAgent: "claude",
      dispatchFailoverEnabled: true,
      dispatchFailoverThresholdPercent: 90,
    });
    expect(onUpdated).toHaveBeenCalledWith({
      aiExecutionProvider: "claude",
      autoRetryLimit: 5,
      claudeModel: "auto",
      githubActionsAgent: "claude",
      githubActionsCodexModel: "gpt-5.6-terra",
      claudeModelAssist: "haiku",
      claudeLocalModel: "sonnet",
      codexModel: "auto",
      defaultDispatchAgent: "claude",
      planReviewAgentForClaude: "claude",
      planReviewAgentForCodex: "codex",
      planReviewClaudeModel: "sonnet",
      planReviewCodexModel: "gpt-5.6-terra",
      dispatchFailoverEnabled: true,
      dispatchFailoverThresholdPercent: 90,
      appAiModel: "claude-haiku-4-5",
      appAiModelReasoning: "claude-sonnet-5-5",
      modelPickEngine: "app-ai",
      dispatchConcurrency: 2,
      // 実行の区分は既定エージェントを送るので、保存後はプロバイダーに追従しない個別設定になる（#4108）
      aiProviderOverrides: {
        githubActionsAgent: false,
        defaultDispatchAgent: true,
        planReviewAgentForClaude: false,
        planReviewAgentForCodex: false,
        appAiModel: false,
        appAiModelReasoning: false,
      },
    });
  });

  it("プロバイダーを切り替えると、保存前でも工程ごとの実効エージェントを切り替えて見せる（#4108）", async () => {
    renderDialog();

    const group = screen.getByRole("group", { name: "AI実行プロバイダー" });
    fireEvent.click(within(group).getByRole("button", { name: "Codex" }));

    const flow = screen.getByRole("list", { name: "Codexを選んだときの各工程" });
    expect(within(flow).getAllByText(/Codex CLI/).length).toBeGreaterThan(0);
    expect(screen.getByText("未保存")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateClaudeModel).toHaveBeenCalledWith({ aiExecutionProvider: "codex" }));
    // 追従している項目は、保存したプロバイダーで解き直した値を親へ返す
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({
      aiExecutionProvider: "codex",
      githubActionsAgent: "codex",
      defaultDispatchAgent: "codex",
      appAiModel: "gpt-5.6-terra",
    }));
  });

  it("兄弟区分の保存済み値を同期し、後の保存で古い値へ巻き戻さない（#3983）", async () => {
    const view = renderDialog();

    // 親からAIモデルの保存済み値が更新された状態を再現する。
    view.rerender(
      <SettingsDialog
        open onOpenChange={() => {}} currentUser={{ login: "octocat", name: "Octo Cat", image: null }}
        autoRetryLimit={2} claudeModel="sonnet" claudeModelAssist="haiku" claudeLocalModel="sonnet"
        codexModel="auto" appAiModel="claude-haiku-4-5" appAiModelReasoning="claude-sonnet-5-5"
        modelPickEngine="app-ai" dispatchConcurrency={2} repositories={repositories}
        onSetRepositoryHidden={onSetRepositoryHidden} onSetRepositoriesHidden={onSetRepositoriesHidden}
        onSetRepositoryIssueCreationExcluded={onSetRepositoryIssueCreationExcluded} onUpdated={onUpdated}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^実行$/ }));
    fireEvent.change(screen.getByLabelText("自動リトライ回数"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());

    // 実行フォームも親の最新保存値へ同期済みなので、古いautoを親へ戻さない。
    expect(onUpdated.mock.calls.at(-1)?.[0].claudeModel).toBe("sonnet");
  });

  it("別区分を保存してもAI・モデルの未保存変更を保存済み扱いにしない（#3983）", async () => {
    renderDialog();

    // AI・モデル側に未保存変更を作る。
    const appAi = screen.getByLabelText("アプリ内AI：要約・検索・文章整理");
    fireEvent.change(appAi, { target: { value: "claude-sonnet-5-5" } });

    // 実行区分だけを保存する。
    fireEvent.click(screen.getByRole("button", { name: /^実行$/ }));
    fireEvent.change(screen.getByLabelText("自動リトライ回数"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());

    // 親へ通知するAI値は保存済み初期値のまま。未保存の値を保存済み扱いにしない。
    expect(onUpdated.mock.calls.at(-1)?.[0].appAiModel).toBe("claude-haiku-4-5");

    // このテストの親はonUpdated後にpropsを更新しない単純なspyなので、フォーム表示値の
    // 再同期まではここで仮定しない。重要な契約は「実行の保存がAIの未保存値を保存済みとして親へ渡さない」こと。
    expect(onUpdated.mock.calls.at(-1)?.[0].appAiModel).toBe("claude-haiku-4-5");
  });

  it("リポジトリの区分でチェックを外すと、そのリポジトリを非表示にする（#3983）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^リポジトリ$/ }));

    expect(screen.getByText(/2件中/).textContent).toBe("2件中1件を表示中");

    const checkboxes = screen.getAllByRole("checkbox");
    // チェックが入っている＝表示中。1件目（issue-deck）は表示、2件目（car-care）は非表示。
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true");
    expect(checkboxes[1].getAttribute("aria-checked")).toBe("false");

    fireEvent.click(checkboxes[0]);
    expect(onSetRepositoryHidden).toHaveBeenCalledWith(repositories[0], true);
  });

  it("リポジトリの区分は行のどこを押しても切り替わり、二重に切り替わらない（#3983）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^リポジトリ$/ }));

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

  it("リポジトリの区分の一括操作は、状態が変わる行だけを渡す（#3983）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^リポジトリ$/ }));

    fireEvent.click(screen.getByRole("button", { name: "すべて表示" }));
    expect(onSetRepositoriesHidden).toHaveBeenCalledWith([repositories[1]], false);

    fireEvent.click(screen.getByRole("button", { name: "すべて非表示" }));
    expect(onSetRepositoriesHidden).toHaveBeenCalledWith([repositories[0]], true);
  });

  it("リポジトリの区分の「作成候補」を外すと、Issue作成の選択肢からだけ除外する（#2760）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^リポジトリ$/ }));

    // 非表示（car-care）には出さず、表示中（issue-deck）にだけ「作成候補」を出す
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(1);

    fireEvent.click(switches[0]);
    expect(onSetRepositoryIssueCreationExcluded).toHaveBeenCalledWith(repositories[0], true);
  });

  it("システム状態の区分ではGitHubの障害状況だけを出す（使用量はStatusHubへ移した）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^システム状態$/ }));

    expect(screen.getByText("GitHub障害状況")).toBeTruthy();
    expect(screen.queryByText("GitHub使用量")).toBeNull();
  });

  // #2631。プラン枠のメーターがAI使用量画面と丸ごと重複していたため、カードごと移した。
  // 見出しの文字列だけを見張ると「AI使用量画面で見られます」の案内文にも当たるので、
  // カードの見出しに使っている要素（`p.text-xs.font-medium`）に絞って見る。
  it("状態の区分にAI使用量のカードは出さない（AI使用量画面へ移した）", () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /^システム状態$/ }));

    // ダイアログはportalでbody直下へ描かれるので、renderのcontainerからは辿れない
    const cardTitles = Array.from(
      document.body.querySelectorAll("p.text-xs.font-medium"),
    ).map((node) => node.textContent);
    expect(cardTitles).toEqual(["GitHub障害状況"]);
  });
});
