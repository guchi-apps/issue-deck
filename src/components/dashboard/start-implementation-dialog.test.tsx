// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
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
    kind: "LAUNCH",
    status: "QUEUED",
    message: null,
    instruction: null,
    command: null,
    placeholderValues: null,
    resolvedCommand: null,
    manualStepLine: null,
    targetJobId: null,
    previewAction: null,
    exitCode: null,
    commandOutput: null,
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
  });

  afterEach(() => {
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
    });
    await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(1));
    expect(updateIssue.mock.calls[0][0].labels).toContain(LOCAL_LABEL_NAME);
    // 無人実行の入口は踏まない。進捗も起動したランチャーが報告する
    expect(createComment).not.toHaveBeenCalled();
    expect(setProgressStatus).not.toHaveBeenCalled();
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

    // チェックボックスの並びはSTART_IMPLEMENTATION_OPTIONSの表示順（先頭が「計画が必要」）
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
      expect(screen.queryByText("計画が必要")).not.toBeNull();
      // 既定はサブPC。作成直後にGitHub Actionsへ固定されないこと自体が#1323の目的
      expect(screen.getByRole("radio", { name: /^サブPC/ }).getAttribute("aria-checked")).toBe("true");
    });

    it("既に付いているラベルは選択状態として引き継ぎ、付け直しのPATCHは投げない", async () => {
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ labels: [{ name: PLAN_REQUIRED_LABEL, color: "ededed" }] as Issue["labels"] }),
      });

      clickStart();

      // 「計画が必要」は既にラベルとして付いている。文面と進捗はそれに従う
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
      expect(screen.queryByRole("checkbox", { name: /開発環境を起動する/ })).not.toBeNull();
    });

    it("GitHub Actionsを選ぶとスクリーンショットのオプションが出る", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      fireEvent.click(screen.getByRole("radio", { name: /GitHub Actions/ }));

      expect(screen.queryByRole("checkbox", { name: /スクリーンショットが必要/ })).not.toBeNull();
    });

    // 隠すと、付いてしまったラベルをこのダイアログから外せなくなる
    it("既に24.screenshot-requiredが付いていればサブPCでも出す", () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({
          labels: [{ name: "24.screenshot-required", color: "d4c5f9", description: null }],
        }),
      });

      expect(screen.queryByRole("checkbox", { name: /スクリーンショットが必要/ })).not.toBeNull();
    });

    it("新機能のIssueでは「計画が必要」にチェックが入った状態で開き、そのままラベルが付く", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ labels: [{ name: "50.feature", color: "0052cc", description: null }] }),
      });

      expect(
        screen.getByRole("checkbox", { name: /計画が必要/ }).getAttribute("aria-checked"),
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
        screen.getByRole("checkbox", { name: /計画が必要/ }).getAttribute("aria-checked"),
      ).toBe("false");
    });

    // デザインは計画の既定（#1317）にも入っているため、2つ同時にチェックが入る（#1956）
    it("デザインのIssueでは「アーティファクトで見た目を出す」にもチェックが入り、そのままラベルが付く", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ labels: [{ name: "62.design", color: "bfdadc", description: null }] }),
      });

      expect(
        screen
          .getByRole("checkbox", { name: /アーティファクトで見た目を出す/ })
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
          .getByRole("checkbox", { name: /アーティファクトで見た目を出す/ })
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
          .getByRole("checkbox", { name: /アーティファクトで見た目を出す/ })
          .getAttribute("aria-checked"),
      ).toBe("false");
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

      // 4つ横並びにするとタイルの幅が80px弱しか無いため、出す文字は短縮版にする
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

    it("オプションはONにしたものだけ説明を出し、押すとラベルも付く", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      // 何も選んでいないうちは、説明の代わりに使い方だけを出す
      expect(screen.getByText("オプションを押すとONになり、ここに内容が出ます。")).not.toBeNull();

      fireEvent.click(screen.getByRole("checkbox", { name: /開発環境を起動する/ }));

      expect(screen.getByText(/PR作成前に開発サーバーを起動し/)).not.toBeNull();
      clickStart();

      await waitFor(() => expect(updateIssue).toHaveBeenCalled());
      expect(updateIssue.mock.calls[0][0].labels).toContain(PREVIEW_REQUIRED_LABEL);
    });

    it("もう一度押すとOFFに戻り、ラベルも付けない", async () => {
      dispatchState.hosts = [makeHost()];
      renderDialog({ includeDispatchTargets: true });

      const chip = screen.getByRole("checkbox", { name: /マージ前に確認が必要/ });
      fireEvent.click(chip);
      expect(chip.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(chip);
      expect(chip.getAttribute("aria-checked")).toBe("false");

      clickStart();

      await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
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

      expect(screen.queryByRole("checkbox", { name: /計画が必要/ })).not.toBeNull();
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

  /**
   * 撮る仕組みを持たないリポジトリでは、実装だけ進んで画像が出ないまま完了する（#1118）。
   * ホスト由来の理由（#1268）と同じ見せ方で、押す前に理由を出す。
   */
  describe("撮影に対応しないリポジトリ（#1118）", () => {
    it("GitHub Actionsでは理由を出して選べなくする", () => {
      dispatchState.hosts = [];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({ repositoryFullName: "guchi-apps/dayspan" }),
      });

      const option = screen.getByRole("checkbox", { name: /スクリーンショットが必要/ });
      expect(option.hasAttribute("disabled")).toBe(true);
      expect(screen.getByText(/無人実行での撮影に対応していない/)).not.toBeNull();
    });

    it("対応しているリポジトリでは塞がない", () => {
      dispatchState.hosts = [];
      renderDialog({ includeDispatchTargets: true });

      const option = screen.getByRole("checkbox", { name: /スクリーンショットが必要/ });
      expect(option.hasAttribute("disabled")).toBe(false);
      expect(screen.queryByText(/無人実行での撮影に対応していない/)).toBeNull();
    });

    // 塞ぐと、付いてしまったラベルをこのダイアログから外せなくなる
    it("既に24.screenshot-requiredが付いていれば外せる", () => {
      dispatchState.hosts = [];
      renderDialog({
        includeDispatchTargets: true,
        issue: makeIssue({
          repositoryFullName: "guchi-apps/dayspan",
          labels: [{ name: "24.screenshot-required", color: "d4c5f9", description: null }],
        }),
      });

      const option = screen.getByRole("checkbox", { name: /スクリーンショットが必要/ });
      expect(option.hasAttribute("disabled")).toBe(false);
      expect(screen.getByText(/無人実行での撮影に対応していない/)).not.toBeNull();
    });
  });
});
