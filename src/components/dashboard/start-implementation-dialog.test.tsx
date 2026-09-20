// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import {
  ARTIFACT_REQUIRED_LABEL,
  MERGE_CONFIRM_REQUIRED_LABEL,
  PREVIEW_REQUIRED_LABEL,
} from "@/lib/github/start-implementation";
import type { Issue, IssueComment } from "@/types/issue";

const updateIssue = vi.fn();
const createComment = vi.fn();
const setProgressStatus = vi.fn();
const enqueue = vi.fn();

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => ({ updateIssue, isSubmitting: false, error: null }),
}));

vi.mock("@/hooks/use-issue-comment-mutations", () => ({
  useIssueCommentMutations: () => ({ createComment, isSubmitting: false, error: null }),
}));

vi.mock("@/hooks/use-progress-status-mutation", () => ({
  useProgressStatusMutation: () => ({ setProgressStatus }),
}));

// 予約実行（#2995）の設定。タイルの説明にON/OFFを出すためだけの取得で、ここでは`fetch`の
// 呼び出し回数を数えるテスト（おまかせ）に混ざらないようフックごと差し替える
vi.mock("@/hooks/use-nightly-run", () => ({
  useNightlyRunSettings: () => null,
}));

// モデルの自動選択（#2723）。**押したときだけ呼ばれる**ことも検証したいので、フックごと
// 差し替えず`fetch`の口を差し替える
const modelPickFetch = vi.fn();

// リポジトリに定義されているラベル（#1956）。アーティファクトの既定を当ててよいかの判定に使う。
// 既定は「25.artifact-requiredを配ってあるリポジトリ」とする
let repositoryLabelNames: string[] = [ARTIFACT_REQUIRED_LABEL];

vi.mock("@/hooks/use-issue-repo-meta", () => ({
  useIssueRepoMeta: () => ({
    labels: repositoryLabelNames.map((name) => ({ name, color: "ededed", description: null })),
    assignees: [],
    isLoading: false,
  }),
}));

// サブPCへのディスパッチ（#1179）の状態。既定は「申告しているホストが無い」
let dispatchState: {
  hosts: DispatchHostView[];
  jobs: DispatchJobView[];
  // 起動済み（セッション生存中）のIssueを積ませない判定（#1311）が読む
  sessions: DispatchSessionView[];
  concurrency: number | null;
  // 最初の取得が終わったか（#1666）。falseの間は選択肢を出さない
  isLoaded: boolean;
  error: string | null;
};

vi.mock("@/hooks/use-dispatch-state", () => ({
  useDispatchState: () => ({
    ...dispatchState,
    // エージェント別の一時停止（#2994）。既定は両方とも稼働中
    agentPause: { claude: null, codex: null },
    isSubmitting: false,
    setError: vi.fn(),
    enqueue,
    cancel: vi.fn(),
  }),
}));

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-14T00:00:00Z",
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    manualStepVpsCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    manualStepSessionCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    launchHold: null,
    checkout: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1248,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    agent: "claude",
    claudeModel: null,
    kind: "LAUNCH",
    status: "QUEUED",
    message: null,
    instruction: null,
    recovery: false,
    command: null,
    placeholderValues: null,
    resolvedCommand: null,
    manualStepLine: null,
    manualStepRunTarget: "subpc",
    targetJobId: null,
    previewAction: null,
    exitCode: null,
    commandOutput: null,
    codexPairingCode: null,
    codexPairingExpiresAt: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: "2026-08-14T00:00:00Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1248,
    title: "スマートフォンからローカル・サブパソコンの開始ボタンを追加",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "guchi", avatarUrl: "" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-14T00:00:00Z",
    updatedAt: "2026-08-14T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1248",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

function renderDialog(
  props: {
    includeDispatchTargets?: boolean;
    issue?: Issue;
    actionsDisabledReason?: string | null;
    localSessionCommand?: string | null;
    onOpenChange?: (open: boolean) => void;
    claudeLocalModel?: "fable" | "opus" | "sonnet" | "pick";
    codexModel?: ComponentProps<typeof StartImplementationDialog>["codexModel"];
  } = {},
) {
  const issue = props.issue ?? makeIssue();
  const onIssueUpdated = vi.fn();
  const onCommentCreated = vi.fn();
  const onOpenChange = props.onOpenChange ?? vi.fn();
  const element = () => (
    <StartImplementationDialog
      issue={issue}
      onIssueUpdated={onIssueUpdated}
      onCommentCreated={onCommentCreated}
      open
      onOpenChange={onOpenChange}
      includeDispatchTargets={props.includeDispatchTargets}
      actionsDisabledReason={props.actionsDisabledReason ?? null}
      localSessionCommand={props.localSessionCommand ?? null}
      claudeLocalModel={props.claudeLocalModel ?? "sonnet"}
      codexModel={props.codexModel ?? "gpt-5.6-terra"}
    />
  );
  const result = render(element());
  // ディスパッチ状態（モック）の変化は、再描画されないと画面へ出ない。
  // 押した後の見え方を確かめるテストで使う
  return { ...result, rerenderSame: () => result.rerender(element()) };
}

function clickStart() {
  fireEvent.click(screen.getByRole("button", { name: "開始する" }));
}

describe("StartImplementationDialog", () => {
  beforeEach(() => {
    dispatchState = {
      hosts: [],
      jobs: [],
      sessions: [],
      concurrency: 2,
      isLoaded: true,
      error: null,
    };
    repositoryLabelNames = [ARTIFACT_REQUIRED_LABEL];
    updateIssue.mockResolvedValue(makeIssue());
    createComment.mockResolvedValue({ id: 1 } as unknown as IssueComment);
    setProgressStatus.mockResolvedValue(undefined);
    enqueue.mockResolvedValue(true);
    modelPickFetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({ model: "opus", reason: "調査から始まるためです。", source: "ai" }),
    });
    vi.stubGlobal("fetch", modelPickFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    updateIssue.mockReset();
    createComment.mockReset();
    setProgressStatus.mockReset();
    enqueue.mockReset();
  });

  it("実行先を選ばせない場合は選択欄を出さず、従来どおり@claudeコメントを投稿する", async () => {
    renderDialog();

    expect(screen.queryByText("実行先")).toBeNull();
    clickStart();

    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));
    expect(createComment.mock.calls[0][0].body).toBe("@claude 実装を開始してください");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("申告しているホストが無くても、手元へ貼る出口があるので選択欄は出す（#1263）", () => {
    renderDialog({ includeDispatchTargets: true });

    expect(screen.queryByText("実行先")).not.toBeNull();
    expect(screen.getByRole("radio", { name: /GitHub Actions/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: /実装プロンプトをコピー/ })).not.toBeNull();
  });

  it("申告があれば実行先を選べ、既定はサブPC（#1262）", () => {
    dispatchState.hosts = [makeHost()];
    renderDialog({ includeDispatchTargets: true });

    expect(screen.getByRole("radio", { name: /^サブPC/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /GitHub Actions/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("選べるホストが無ければ既定はGitHub Actionsへ落ちる（#1262）", () => {
    dispatchState.hosts = [makeHost({ online: false })];
    renderDialog({ includeDispatchTargets: true });

    expect(screen.getByRole("radio", { name: /GitHub Actions/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("Actionsが使えないリポジトリでも、トリガーは押せてサブPCで開始できる（#1262）", async () => {
    dispatchState.hosts = [makeHost()];
    renderDialog({
      includeDispatchTargets: true,
      actionsDisabledReason: "issue-deckの自動化workflowが見つかりません",
    });

    // Actionsの選択肢だけが落ち、既定のサブPCでそのまま開始できる
    expect((screen.getByRole("radio", { name: /GitHub Actions/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    clickStart();

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(createComment).not.toHaveBeenCalled();
  });

  it("Actionsを選んでいて使えない場合は開始できず、理由を出す（#1262）", () => {
    renderDialog({
      includeDispatchTargets: true,
      actionsDisabledReason: "issue-deckの自動化workflowが見つかりません",
    });

    // 理由は選択肢のグリッドの下に出る（#1623。タイルには収まらないため）
    expect(screen.getByText(/issue-deckの自動化workflowが見つかりません/)).not.toBeNull();
    expect((screen.getByRole("button", { name: "開始する" }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe("手元へ貼る出口（#1263）", () => {
    const writeText = vi.fn();

    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
    });

    it("実装プロンプトをコピーすると、11.localを付け進捗も報告する", async () => {
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /実装プロンプトをコピー/ }));
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      // ランチャーを通らないので、二重起動の停止と盤面の追従はここで行う
      await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(1));
      expect(updateIssue.mock.calls[0][0].labels).toContain(LOCAL_LABEL_NAME);
      await waitFor(() => expect(setProgressStatus).toHaveBeenCalledTimes(1));
      expect(createComment).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      // Issueの中身が入った文面であること
      expect(writeText.mock.calls[0][0]).toContain("#1248");
    });

    it("クリップボードが使えない環境ではラベルも進捗も動かさない", async () => {
      writeText.mockRejectedValue(new Error("denied"));
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /実装プロンプトをコピー/ }));
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(updateIssue).not.toHaveBeenCalled();
      expect(setProgressStatus).not.toHaveBeenCalled();
    });

    it("起動コマンドは渡されていなければ選択肢に出さない", () => {
      renderDialog({ includeDispatchTargets: true });

      expect(screen.queryByRole("radio", { name: /起動コマンドをコピー/ })).toBeNull();
    });

    it("起動コマンドのコピーでは11.localを付けない（受け口側が同じことをするため）", async () => {
      renderDialog({ includeDispatchTargets: true, localSessionCommand: "run.sh a b 1" });

      fireEvent.click(screen.getByRole("radio", { name: /起動コマンドをコピー/ }));
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith("run.sh a b 1"));
      expect(updateIssue).not.toHaveBeenCalled();
      expect(setProgressStatus).not.toHaveBeenCalled();
    });
  });

  it("サブPCを選ぶとジョブを積み、11.localを付け、@claudeコメントは投稿しない", async () => {
    dispatchState.hosts = [makeHost()];
    renderDialog({ includeDispatchTargets: true });

    fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
    clickStart();

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue.mock.calls[0][0]).toEqual({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1248,
      hostName: "subpc",
      // 選ばなければ既定のClaude Code（#2505）
      agent: "claude",
      // 選ばなければ設定（設定 ＞ 実行）の値が最初から選ばれている（#3106）
      model: "sonnet",
    });
    await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(1));
    expect(updateIssue.mock.calls[0][0].labels).toContain(LOCAL_LABEL_NAME);
    // 無人実行の入口は踏まない。進捗も起動したランチャーが報告する
    expect(createComment).not.toHaveBeenCalled();
    expect(setProgressStatus).not.toHaveBeenCalled();
  });

  describe("エージェントの選択（#2505）", () => {
    it("Codexに対応していないホストでは選択欄を出さない", () => {
      // **未申告（古いpoller）も出さない。** 配ると`agent`ごと無視されてClaude Codeが黙って立つ
      dispatchState.hosts = [makeHost({ codexCapable: null })];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      expect(screen.queryByRole("radiogroup", { name: "エージェント" })).toBeNull();
    });

    it("対応しているホストでは選択欄を出し、既定はClaude Code", () => {
      dispatchState.hosts = [makeHost({ codexCapable: true })];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      expect(screen.getByRole("radiogroup", { name: "エージェント" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "Claude Code" }).getAttribute("aria-checked")).toBe(
        "true",
      );
      // 押していないうちは注意を出さない（縦に伸ばさない）
      expect(screen.queryByText(/画面からの連携が一部効きません/)).toBeNull();
    });

    it("Codexを選ぶと、その場で効かなくなる連携を出す", () => {
      dispatchState.hosts = [makeHost({ codexCapable: true })];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: "Codex CLI" }));

      expect(screen.getByText(/画面からの連携が一部効きません/)).toBeTruthy();
      expect(screen.getByText(/Remote Control/)).toBeTruthy();
    });

    it("Codexを選んで開始するとジョブへ載る", async () => {
      dispatchState.hosts = [makeHost({ codexCapable: true })];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: "Codex CLI" }));
      clickStart();

      await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      expect(enqueue.mock.calls[0][0].agent).toBe("codex");
    });

    it("実行先をGitHub Actionsへ移すと既定へ戻る（選択が付いていかない）", async () => {
      dispatchState.hosts = [makeHost({ codexCapable: true })];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: "Codex CLI" }));
      fireEvent.click(screen.getByRole("radio", { name: "GitHub Actions" }));

      expect(screen.queryByRole("radiogroup", { name: "エージェント" })).toBeNull();
      clickStart();
      await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  /**
   * #2717。**重いIssueだけモデルを上げるための欄**。最初の選択は設定（設定 ＞ 実行）の値で、
   * 「設定に従う」は#3106で削除した。
   * GitHub Actionsは設定を全体で読む別経路で、ジョブに積んだ値は届かない。
   */
  describe("モデルの選択（#2717・#3106）", () => {
    it("サブPCを選ぶと、おまかせ・Fable・Opus・Sonnetの4つを出し、設定の値が選ばれている", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true, claudeLocalModel: "opus" });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      const group = screen.getByRole("radiogroup", { name: "モデル" });
      expect(within(group).getAllByRole("radio")).toHaveLength(4);
      expect(screen.queryByRole("radio", { name: /設定に従う/ })).toBeNull();
      const checked = (name: RegExp) =>
        screen.getByRole("radio", { name }).getAttribute("aria-checked");
      expect(checked(/^Opus/)).toBe("true");
      expect(checked(/^Sonnet/)).toBe("false");
      expect(checked(/^おまかせ/)).toBe("false");
    });

    // #2776。「どのモデルで動くか分からないまま起動できる方式」自体が不要というIssueの要求により削除
    it("「CLIの既定」は選択肢に出さない", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      expect(screen.queryByRole("radio", { name: /CLIの既定/ })).toBeNull();
    });

    // #3119。ダイアログを1画面に収めるため、手動で選んだモデルの説明文は出さない
    it("設定の値のモデルにも、設定で選んだ旨の説明文は出さない", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true, claudeLocalModel: "opus" });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      expect(screen.getByRole("radio", { name: /^Opus/ }).getAttribute("aria-checked")).toBe("true");
      expect(screen.queryByText(/設定（設定 ＞ 実行）で選んだ/)).toBeNull();
    });

    /**
     * #3106。設定が「おまかせ」なら、開いた直後（モデル欄が出た時点）に**自動で**判定する。
     * 押したときだけ呼ぶ従来の経路（下）とは別に、初期値が「おまかせ」のときだけ走る。
     */
    describe("初期値がおまかせ", () => {
      it("サブPCを選んでモデル欄が出たら、押さなくても判定し、そのモデルで積む", async () => {
        dispatchState.hosts = [makeHost()];
        renderDialog({ includeDispatchTargets: true, claudeLocalModel: "pick" });

        fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
        expect(screen.getByRole("radio", { name: /^おまかせ/ }).getAttribute("aria-checked")).toBe(
          "true",
        );
        await waitFor(() => expect(screen.getByText(/調査から始まるためです/)).toBeTruthy());
        expect(modelPickFetch).toHaveBeenCalledTimes(1);

        clickStart();
        await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
        expect(enqueue.mock.calls[0][0].model).toBe("opus");
      });

      it("判定が終わるまで開始を押させない", async () => {
        dispatchState.hosts = [makeHost()];
        modelPickFetch.mockReturnValue(new Promise(() => {}));
        renderDialog({ includeDispatchTargets: true, claudeLocalModel: "pick" });

        fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "開始する" }).hasAttribute("disabled")).toBe(
            true,
          ),
        );
      });

      // 実行先がActionsのあいだは判定しない（枠の無駄遣い）。ホストが無く最初はActionsのときは、
      // サブPCを選んでモデル欄が出た時点で判定する。切り替えを繰り返しても1回だけ
      it("モデル欄が出るまでは判定せず、出たときに1回だけ判定する", async () => {
        dispatchState.hosts = [];
        const { rerenderSame } = renderDialog({
          includeDispatchTargets: true,
          claudeLocalModel: "pick",
        });
        expect(screen.queryByRole("radiogroup", { name: "モデル" })).toBeNull();
        expect(modelPickFetch).not.toHaveBeenCalled();

        dispatchState.hosts = [makeHost()];
        rerenderSame();
        fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
        await waitFor(() => expect(modelPickFetch).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole("radio", { name: "GitHub Actions" }));
        fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
        await waitFor(() => expect(screen.getByText(/調査から始まるためです/)).toBeTruthy());
        expect(modelPickFetch).toHaveBeenCalledTimes(1);
      });

      // 失敗しても繰り返し呼ばない。やり直すときは「おまかせ」を押し直す
      it("判定に失敗しても自動では繰り返さない", async () => {
        dispatchState.hosts = [makeHost()];
        modelPickFetch.mockResolvedValue({ ok: false, status: 500 });
        renderDialog({ includeDispatchTargets: true, claudeLocalModel: "pick" });

        fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
        await waitFor(() => expect(screen.getByText(/モデルを選べませんでした/)).toBeTruthy());
        expect(modelPickFetch).toHaveBeenCalledTimes(1);
      });
    });

    it("初期値がおまかせでなければ、モデル欄が出ても判定しない", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true, claudeLocalModel: "sonnet" });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      expect(modelPickFetch).not.toHaveBeenCalled();
    });

    it("GitHub Actionsでは選択欄を出さない（設定の既定でしか起動しないため）", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: "GitHub Actions" }));
      expect(screen.queryByRole("radiogroup", { name: "モデル" })).toBeNull();
    });

    /**
     * #3192。Codexを選ぶと、同じ位置の「モデル」欄がCodexの候補（おまかせ・Sol・Terra・Luna）へ
     * 切り替わる。積む値は今のエージェントの選択だけで、もう一方の選択は付いていかない。
     */
    describe("Codexのモデル（#3192）", () => {
      const openCodex = (props: Parameters<typeof renderDialog>[0] = {}) => {
        dispatchState.hosts = [makeHost({ codexCapable: true })];
        renderDialog({ includeDispatchTargets: true, ...props });
        fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
        fireEvent.click(screen.getByRole("radio", { name: "Codex CLI" }));
      };
      const checked = (name: RegExp) =>
        screen.getByRole("radio", { name }).getAttribute("aria-checked");

      it("Codexを選ぶと、おまかせ・Sol・Terra・Lunaの4つに切り替わり、設定の値が選ばれている", () => {
        openCodex({ codexModel: "gpt-5.6-sol" });

        const group = screen.getByRole("radiogroup", { name: "モデル" });
        expect(within(group).getAllByRole("radio")).toHaveLength(4);
        expect(screen.queryByRole("radio", { name: /^Opus/ })).toBeNull();
        expect(checked(/^Sol/)).toBe("true");
        expect(checked(/^Terra/)).toBe("false");
      });

      it("選んだモデルを積む（Claude Codeの選択は付いていかない）", async () => {
        openCodex({ claudeLocalModel: "fable" });
        fireEvent.click(screen.getByRole("radio", { name: /^Luna/ }));
        clickStart();

        await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
        expect(enqueue.mock.calls[0][0]).toMatchObject({ agent: "codex", model: "gpt-5.6-luna" });
      });

      // 旧世代・`auto`はダイアログの候補に無く、選択なしで開くと何で立つか分からなくなる
      it("設定が旧世代（GPT-5.5）のときは、Terraが選ばれた状態で開く", () => {
        openCodex({ codexModel: "gpt-5.5" });

        expect(checked(/^Terra/)).toBe("true");
      });

      it("エージェントを行き来しても、それぞれの選択が残る", () => {
        openCodex({ claudeLocalModel: "opus" });
        fireEvent.click(screen.getByRole("radio", { name: /^Sol/ }));
        fireEvent.click(screen.getByRole("radio", { name: /^Claude Code/ }));
        expect(checked(/^Opus/)).toBe("true");
        fireEvent.click(screen.getByRole("radio", { name: "Codex CLI" }));
        expect(checked(/^Sol/)).toBe("true");
      });

      it("おまかせを押すとCodex向けに判定し、選ばれたモデルで積む", async () => {
        modelPickFetch.mockResolvedValue({
          ok: true,
          json: async () => ({
            model: "gpt-5.6-terra",
            reason: "通常の実装だと読めるためです。",
            source: "ai",
          }),
        });
        openCodex();
        fireEvent.click(screen.getByRole("radio", { name: /^おまかせ/ }));

        await waitFor(() => expect(screen.getByText(/通常の実装だと読めるためです/)).toBeTruthy());
        expect(screen.getByTitle("おまかせが選んだモデル").textContent).toContain("Terra");
        const body = JSON.parse(modelPickFetch.mock.calls[0][1].body as string);
        expect(body.agent).toBe("codex");

        clickStart();
        await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
        expect(enqueue.mock.calls[0][0].model).toBe("gpt-5.6-terra");
      });

      it("設定がおまかせなら、Codexを選んだ時点で自動判定する（Claude Code側の判定とは別に1回）", async () => {
        modelPickFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ model: "gpt-5.6-sol", reason: "調査が要るためです。", source: "ai" }),
        });
        openCodex({ codexModel: "pick" });

        await waitFor(() => expect(screen.getByText(/調査が要るためです/)).toBeTruthy());
        expect(modelPickFetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(modelPickFetch.mock.calls[0][1].body as string).agent).toBe("codex");
      });

      it("判定が終わるまで開始を押させない", async () => {
        modelPickFetch.mockReturnValue(new Promise(() => {}));
        openCodex({ codexModel: "pick" });

        await waitFor(() =>
          expect(screen.getByRole("button", { name: "開始する" }).hasAttribute("disabled")).toBe(
            true,
          ),
        );
      });
    });

    // #2723。金額（1件あたりの目安）は何の金額か画面から決まらず、FableとOpusがほぼ並ぶため
    // 見比べても選べなかった。出すのは「向いている作業」で、実績は「AI使用量」の画面で見る
    it("Fableを選ぶと向いている作業はチップに出し、金額は出さない", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: /^Fable/ }));
      expect(screen.getByRole("radio", { name: /^Fable/ }).textContent).toContain("難しい調査・設計から");
      // 選んだあとの説明文は出さない（#3119）
      expect(screen.queryByText(/原因が読めない不具合/)).toBeNull();
      expect(screen.queryByText(/\$/)).toBeNull();

      clickStart();
      await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      expect(enqueue.mock.calls[0][0].model).toBe("fable");
    });

    /**
     * #2723。「おまかせ」はissue-deckがIssueを読んで選ぶ。**押したときだけ判定を呼び**、
     * 積むのは決まった具体的なモデル名（`auto`ではない）。
     */
    it("おまかせを押すと判定し、選ばれたモデルと理由を出してそのモデルで積む", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      // 開いただけでは呼ばない（枠を消費しないため）
      expect(modelPickFetch).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("radio", { name: /^おまかせ/ }));
      await waitFor(() => expect(screen.getByText(/調査から始まるためです/)).toBeTruthy());
      expect(modelPickFetch.mock.calls[0][0]).toBe("/api/issues/model-pick");

      clickStart();
      await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      expect(enqueue.mock.calls[0][0].model).toBe("opus");
    });

    /**
     * #3189。Jevで判定したときだけ、判定元のバッジ・確信度・候補ごとの確率を出す。
     * **接戦だったのかが押す前に分かる**ようにするためで、理由の1文だけでは読み取れない。
     */
    it("Jevの判定なら確信度と候補ごとの確率を出す", async () => {
      dispatchState.hosts = [makeHost()];
      modelPickFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          model: "opus",
          reason: "難しさ 2/3と判定したためです。",
          source: "jev",
          confidence: 0.82,
          probabilities: { opus: 0.82, sonnet: 0.15, fable: 0.03 },
        }),
      });
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: /^おまかせ/ }));

      await waitFor(() => expect(screen.getByText("Jev")).toBeTruthy());
      expect(screen.getByText(/確信度 82%/)).toBeTruthy();
      // #3231。確率は下部の一覧ではなく、対応する各モデルのカード内に置く。
      expect(within(screen.getByRole("radio", { name: /^Opus/ })).getByText("82%")).toBeTruthy();
      expect(within(screen.getByRole("radio", { name: /^Sonnet/ })).getByText("15%")).toBeTruthy();
      expect(within(screen.getByRole("radio", { name: /^Fable/ })).getByText("3%")).toBeTruthy();
    });

    // アプリ内AI・ルールの判定は確率を返さないので、確率の行ごと出さない
    it("Jev以外の判定ではバッジも確率も出さない", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: /^おまかせ/ }));

      await waitFor(() => expect(screen.getByText(/調査から始まるためです/)).toBeTruthy());
      expect(screen.queryByText("Jev")).toBeNull();
      expect(screen.queryByText(/確信度/)).toBeNull();
    });

    /**
     * #3154。おまかせが選んだモデルのチップに印（`title`と読み上げ文）を付ける。
     * **選んでいる（`aria-checked`）のは「おまかせ」のまま**で、印は結果を示すだけ。
     */
    it("おまかせが選んだモデルのチップだけに印が付き、押すと手動選択へ切り替わる", async () => {
      dispatchState.hosts = [makeHost()];
      let resolvePick: (value: unknown) => void = () => {};
      modelPickFetch.mockReturnValue(
        new Promise((resolve) => {
          resolvePick = resolve;
        }),
      );
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: /^おまかせ/ }));

      // 判定中はどれにも付かない
      await waitFor(() => expect(screen.getByText(/モデルを選んでいます/)).toBeTruthy());
      expect(screen.queryAllByTitle("おまかせが選んだモデル")).toHaveLength(0);

      resolvePick({
        ok: true,
        json: async () => ({ model: "opus", reason: "調査から始まるためです。", source: "ai" }),
      });
      const opus = await screen.findByRole("radio", { name: /^Opus/ });
      expect(opus.getAttribute("title")).toBe("おまかせが選んだモデル");
      expect(opus.getAttribute("aria-checked")).toBe("false");
      expect(screen.getByRole("radio", { name: /^おまかせ/ }).getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(screen.queryAllByTitle("おまかせが選んだモデル")).toHaveLength(1);

      // 押すと手動で選んだ扱いになり、おまかせの印は外れる
      fireEvent.click(opus);
      expect(opus.getAttribute("aria-checked")).toBe("true");
      expect(screen.queryAllByTitle("おまかせが選んだモデル")).toHaveLength(0);
    });

    // 決まる前に押せてしまうと、選んだつもりのないモデルで立つ
    it("判定が終わるまで開始を押させない", async () => {
      dispatchState.hosts = [makeHost()];
      let resolvePick: (value: unknown) => void = () => {};
      modelPickFetch.mockReturnValue(
        new Promise((resolve) => {
          resolvePick = resolve;
        }),
      );
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: /^おまかせ/ }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "開始する" }).hasAttribute("disabled")).toBe(
          true,
        ),
      );

      resolvePick({
        ok: true,
        // 候補にあるモデルだけを採る（`haiku`のような候補外の値は判定なし扱いになる。#3192）
        json: async () => ({ model: "sonnet", reason: "定型的な追記のためです。", source: "ai" }),
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "開始する" }).hasAttribute("disabled")).toBe(
          false,
        ),
      );
    });

    // AIを呼べなくても起動そのものは塞がない（ラベルと分量からのルールへ倒れる）
    it("ルールで選ばれた場合はその旨も出す", async () => {
      dispatchState.hosts = [makeHost()];
      modelPickFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ model: "sonnet", reason: "通常の実装だからです。", source: "rule" }),
      });
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: /^おまかせ/ }));
      await waitFor(() => expect(screen.getByText(/ラベルと分量から選びました/)).toBeTruthy());
    });

    it("実行先をGitHub Actionsへ移すと選択が付いていかない", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      fireEvent.click(screen.getByRole("radio", { name: /^Fable/ }));
      fireEvent.click(screen.getByRole("radio", { name: "GitHub Actions" }));
      clickStart();

      await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  it("積めなかった場合は11.localを付けない（無人実行まで触れなくなるため）", async () => {
    dispatchState.hosts = [makeHost()];
    enqueue.mockResolvedValue(false);
    renderDialog({ includeDispatchTargets: true });

    fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
    clickStart();

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("オプションのラベルはサブPC経路でも起動前に付ける", async () => {
    dispatchState.hosts = [makeHost()];
    renderDialog({ includeDispatchTargets: true });

    // チェックボックスの並びはSTART_IMPLEMENTATION_OPTIONSの表示順（先頭が「計画を立案」）
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
    clickStart();

    await waitFor(() => expect(updateIssue).toHaveBeenCalled());
    expect(updateIssue.mock.calls[0][0].labels).toContain(PLAN_REQUIRED_LABEL);
    expect(updateIssue.mock.calls[0][0].labels).not.toContain(LOCAL_LABEL_NAME);
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
  });

  describe("Issue作成画面から開く場合（#1323・#1580）", () => {
    it("オプションと実行先の両方を選ばせる", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      // オプションは作成フォームでは選ばせず、この画面だけで選ぶ（#1580）
      expect(screen.queryByText("計画を立案")).not.toBeNull();
      // 既定はサブPC。作成直後にGitHub Actionsへ固定されないこと自体が#1323の目的
      expect(screen.getByRole("radio", { name: /^サブPC/ }).getAttribute("aria-checked")).toBe("true");
    });

    it("既に付いているラベルは選択状態として引き継ぎ、付け直しのPATCHは投げない", async () => {
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ labels: [{ name: PLAN_REQUIRED_LABEL, color: "ededed" }] as Issue["labels"] }),
      });

      clickStart();

      // 「計画を立案」は既にラベルとして付いている。文面と進捗はそれに従う
      await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));
      expect(createComment.mock.calls[0][0].body).toBe("@claude 計画を立案してください");
      expect(setProgressStatus.mock.calls[0][0].status).toBe("planning");
      expect(updateIssue).not.toHaveBeenCalled();
    });
  });

  describe("オプションの出し分け（#1317）", () => {
    // サブPC・ローカル実行はtailscale serveで実物の画面を見られるため、撮影は無人実行専用にする
    it("サブPCが既定のときはスクリーンショットのオプションを出さない", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      expect(screen.queryByRole("checkbox", { name: /スクリーンショットが必要/ })).toBeNull();
      expect(screen.queryByRole("checkbox", { name: /開発環境を起動/ })).not.toBeNull();
    });

    it("新機能のIssueでは「計画を立案」にチェックが入った状態で開き、そのままラベルが付く", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ labels: [{ name: "50.feature", color: "0052cc", description: null }] }),
      });

      expect(
        screen.getByRole("checkbox", { name: /計画を立案/ }).getAttribute("aria-checked"),
      ).toBe("true");
      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      clickStart();

      await waitFor(() => expect(updateIssue).toHaveBeenCalled());
      expect(updateIssue.mock.calls[0][0].labels).toContain(PLAN_REQUIRED_LABEL);
    });

    it("バグ修正のIssueではチェックが入らない", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ labels: [{ name: "30.bug", color: "b60205", description: null }] }),
      });

      expect(
        screen.getByRole("checkbox", { name: /計画を立案/ }).getAttribute("aria-checked"),
      ).toBe("false");
    });

    // デザインは計画の既定（#1317）にも入っているため、2つ同時にチェックが入る（#1956）
    it("デザインのIssueでは「デザインを提示」にもチェックが入り、そのままラベルが付く", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ labels: [{ name: "62.design", color: "bfdadc", description: null }] }),
      });

      expect(
        screen
          .getByRole("checkbox", { name: /デザインを提示/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      clickStart();

      await waitFor(() => expect(updateIssue).toHaveBeenCalled());
      expect(updateIssue.mock.calls[0][0].labels).toContain(ARTIFACT_REQUIRED_LABEL);
    });

    // 存在しないラベル名を渡すと、色も説明も無いラベルがその場で作られる（#1490・#1956）
    it("25.artifact-requiredを配っていないリポジトリでは、デザインのIssueでもチェックが入らない（#1956）", () => {
      dispatchState.hosts = [makeHost()];
      repositoryLabelNames = ["62.design", PLAN_REQUIRED_LABEL];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ labels: [{ name: "62.design", color: "bfdadc", description: null }] }),
      });

      expect(
        screen
          .getByRole("checkbox", { name: /デザインを提示/ })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });

    it("改善のIssueではアーティファクトにチェックが入らない（#1956）", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ labels: [{ name: "51.improvement", color: "0052cc", description: null }] }),
      });

      expect(
        screen
          .getByRole("checkbox", { name: /デザインを提示/ })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });
  });

  // #2884計画レビュー（G1）の指摘1: チェックを外して外す予定のラベルは、外れた後の状態で
  // 予約実行の可否を判定する。生の実ラベルのままだと、外したいのにボタンがdisabledのままになり
  // 削除処理（applyOptionLabels）へ到達できない
  describe("予約実行とオプションの整合（#2884）", () => {
    it("25.artifact-requiredが付いたままだと次の5時間枠は選べない", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({
          labels: [{ name: ARTIFACT_REQUIRED_LABEL, color: "d4c5f9", description: null }],
        }),
      });

      expect(
        screen.getByRole("radio", { name: "次の5時間枠" }).hasAttribute("disabled"),
      ).toBe(true);
    });

    it("チェックを外すと、実ラベルが残っていても次の5時間枠を選べるようになる", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({
          labels: [{ name: ARTIFACT_REQUIRED_LABEL, color: "d4c5f9", description: null }],
        }),
      });

      fireEvent.click(screen.getByRole("checkbox", { name: /デザインを提示/ }));

      expect(
        screen.getByRole("radio", { name: "次の5時間枠" }).hasAttribute("disabled"),
      ).toBe(false);
    });

    it("次の5時間枠を選んだときだけ、選べないオプションの理由をグリッドの下に出す（#3046）", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      expect(screen.queryByText(/では選べません/)).toBeNull();

      fireEvent.click(screen.getByRole("radio", { name: "次の5時間枠" }));

      expect(screen.getAllByText(/では選べません/)).toHaveLength(2);
    });
  });

  // #2884計画レビュー（G1）の指摘2: リポジトリのラベル一覧が遅れて届くと、アーティファクトの
  // 既定ON再適用effectがもう一度走る。ユーザーが既にOFFへ押し戻していた場合、それを巻き戻さない
  describe("アーティファクトの既定再適用とチェックの整合（#2884）", () => {
    it("外した後にリポジトリのラベル一覧が遅れて届いても、チェックは戻らない", () => {
      dispatchState.hosts = [makeHost()];
      // リポジトリのラベル一覧はまだ届いていない状態で開く
      repositoryLabelNames = [];
      const { rerenderSame } = renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({
          labels: [
            { name: ARTIFACT_REQUIRED_LABEL, color: "d4c5f9", description: null },
            { name: "62.design", color: "bfdadc", description: null },
          ],
        }),
      });

      const chip = screen.getByRole("checkbox", { name: /デザインを提示/ });
      expect(chip.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(chip);
      expect(chip.getAttribute("aria-checked")).toBe("false");

      // リポジトリのラベル一覧が遅れて届く
      repositoryLabelNames = [ARTIFACT_REQUIRED_LABEL];
      rerenderSame();

      expect(chip.getAttribute("aria-checked")).toBe("false");
    });
  });

  // 実行先を上・オプションを下に置き、オプションはアイコン付きのチップで選ばせる（#1623）
  describe("実行先とオプションの並び（#1623）", () => {
    it("実行先がオプションより前に描画される", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      const headings = screen
        .getAllByText(/^(実行先|オプション)$/)
        .map((element) => element.textContent);
      expect(headings).toEqual(["実行先", "オプション"]);
    });

    it("実行先のタイルは短い名前を出し、読み上げには正式名称を残す", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true, localSessionCommand: "start-issue 1248" });

      // 5つを1行に並べるとタイルの幅が60px強しか無いため、出す文字は短縮版にする
      expect(screen.getByRole("radio", { name: "実装プロンプトをコピー" }).textContent).toBe(
        "プロンプト",
      );
      expect(screen.getByRole("radio", { name: "起動コマンドをコピー" }).textContent).toBe("コマンド");
      expect(screen.getByRole("radio", { name: "GitHub Actions" }).textContent).toBe("Actions");
    });

    it("選択中の実行先の説明をグリッドの下に出す", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      expect(screen.getByText(/サブPCが取りに来た時点で起動します/)).not.toBeNull();

      fireEvent.click(screen.getByRole("radio", { name: "GitHub Actions" }));

      expect(screen.queryByText(/サブPCが取りに来た時点で起動します/)).toBeNull();
      expect(screen.getByText(/無人実行のワークフローを起動します/)).not.toBeNull();
    });

    it("オプションの説明欄は出さず（#3046）、押すとラベルが付く", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      expect(screen.queryByText("オプションを押すとONになり、ここに内容が出ます。")).toBeNull();

      const chip = screen.getByRole("checkbox", { name: /開発環境を起動/ });
      fireEvent.click(chip);

      // 説明は本文には出さず、チップのtitle（hover・長押し）にだけ残す
      expect(screen.queryByText(/PR作成前に開発サーバーを起動し/)).toBeNull();
      expect(chip.getAttribute("title")).toMatch(/PR作成前に開発サーバーを起動し/);
      clickStart();

      await waitFor(() => expect(updateIssue).toHaveBeenCalled());
      expect(updateIssue.mock.calls[0][0].labels).toContain(PREVIEW_REQUIRED_LABEL);
    });

    it("もう一度押すとOFFに戻り、ラベルも付けない", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      const chip = screen.getByRole("checkbox", { name: /マージ前に確認/ });
      fireEvent.click(chip);
      expect(chip.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(chip);
      expect(chip.getAttribute("aria-checked")).toBe("false");

      clickStart();

      await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      expect(updateIssue.mock.calls[0][0].labels).not.toContain(MERGE_CONFIRM_REQUIRED_LABEL);
    });

    // 選んだオプションどおりにラベルが付き、その内容で実行されるようにする（#2884）
    it("既に付いているラベルのチェックを外すと、実行開始時にラベルも外れる", async () => {
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({
          labels: [{ name: MERGE_CONFIRM_REQUIRED_LABEL, color: "d93f0b" }] as Issue["labels"],
        }),
      });

      const chip = screen.getByRole("checkbox", { name: /マージ前に確認/ });
      expect(chip.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(chip);
      expect(chip.getAttribute("aria-checked")).toBe("false");

      clickStart();

      await waitFor(() => expect(updateIssue).toHaveBeenCalled());
      expect(updateIssue.mock.calls[0][0].labels).not.toContain(MERGE_CONFIRM_REQUIRED_LABEL);
    });
  });

  describe("押した直後の選択欄（#1318）", () => {
    beforeEach(() => {
      dispatchState.hosts = [makeHost()];
      // 積んだジョブは次の取得で返ってくる。押した直後は`already_queued`の判定材料になる
      enqueue.mockImplementation(async () => {
        dispatchState.jobs = [makeJob()];
        return true;
      });
    });

    it("自分が積んだジョブで選択がGitHub Actionsへ移らない", async () => {
      const onOpenChange = vi.fn();
      const { rerenderSame } = renderDialog({ includeDispatchTargets: true, onOpenChange });

      // 既定（サブPC）のまま押す。押していないGitHub Actionsが既定として光ってはいけない
      clickStart();

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(enqueue).toHaveBeenCalledTimes(1);
      // 閉じ切るまでの間（閉じるアニメーション中）も中身は描画され続ける
      rerenderSame();
      const subpc = screen.getByRole("radio", { name: /^サブPC/ });
      expect(subpc.getAttribute("aria-checked")).toBe("true");
      expect(subpc.hasAttribute("disabled")).toBe(false);
      expect(screen.getByRole("radio", { name: /GitHub Actions/ }).getAttribute("aria-checked")).toBe(
        "false",
      );
    });

    it("ジョブを積めた時点で閉じ、11.localの付与を待たない", async () => {
      const onOpenChange = vi.fn();
      // GitHubへの往復が終わらないまま開き続けないこと
      updateIssue.mockReturnValue(new Promise(() => {}));
      renderDialog({ includeDispatchTargets: true, onOpenChange });

      fireEvent.click(screen.getByRole("radio", { name: /^サブPC/ }));
      clickStart();

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(1));
    });

    it("積めなかった場合は開いたまま、通常どおりの選択欄に戻す", async () => {
      enqueue.mockResolvedValue(false);
      const onOpenChange = vi.fn();
      renderDialog({ includeDispatchTargets: true, onOpenChange });

      clickStart();

      await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole("radio", { name: /^サブPC/ }).getAttribute("aria-checked")).toBe("true");
    });
  });

  // ホストの一覧が届く前に選択肢を組むと、サブPC抜きの選択欄を出してから差し替えることになる
  describe("実行先が確定するまで（#1666）", () => {
    it("選択肢を1つも出さず、開始も押させない", () => {
      dispatchState.isLoaded = false;
      renderDialog({ includeDispatchTargets: true });

      // 骨組みは出す（見出しと高さは確定後と同じ）が、押せる選択肢は無い
      expect(screen.queryByText("実行先")).not.toBeNull();
      expect(screen.queryAllByRole("radio")).toHaveLength(0);
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
      expect((screen.getByRole("button", { name: "開始する" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });

    it("確定した時点でサブPCを含む選択肢を出す", () => {
      dispatchState.isLoaded = false;
      const { rerenderSame } = renderDialog({ includeDispatchTargets: true });

      dispatchState.isLoaded = true;
      dispatchState.hosts = [makeHost()];
      rerenderSame();

      expect(screen.getByRole("radio", { name: /^サブPC/ }).getAttribute("aria-checked")).toBe("true");
      expect((screen.getByRole("button", { name: "開始する" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    // 取得に失敗しても`isLoaded`は立つ。従来どおり（サブPC抜き）で操作できる方が、待たせるより軽い
    it("申告しているホストが無いと確定した場合は待たせない", () => {
      renderDialog({ includeDispatchTargets: true });

      expect(screen.getByRole("radio", { name: /GitHub Actions/ }).getAttribute("aria-checked")).toBe(
        "true",
      );
      expect((screen.getByRole("button", { name: "開始する" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    // 実行先を選ばせない呼び出し（Issue作成直後の自動オープン等）は、待つ相手がいない
    it("実行先を選ばせない場合はオプションをそのまま出す", () => {
      dispatchState.isLoaded = false;
      renderDialog();

      expect(screen.queryByRole("checkbox", { name: /計画を立案/ })).not.toBeNull();
      expect((screen.getByRole("button", { name: "開始する" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });

  it("実行できないリポジトリのホストは理由を出して選べなくする", () => {
    dispatchState.hosts = [makeHost({ repositories: ["guchi-apps/dayspan"] })];
    renderDialog({ includeDispatchTargets: true });

    const option = screen.getByRole("radio", { name: /^サブPC/ });
    expect(option.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(/guchi-apps\/issue-deck は サブPC で実行できません/),
    ).not.toBeNull();
  });

});
