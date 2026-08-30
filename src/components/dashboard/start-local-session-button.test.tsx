// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartLocalSessionButton } from "@/components/dashboard/start-local-session-button";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { Issue, IssueLabel } from "@/types/issue";

const updateIssue = vi.fn();

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => ({
    updateIssue,
    isSubmitting: false,
    error: null,
  }),
}));

const enqueue = vi.fn();
const cancel = vi.fn();
let dispatchState: {
  hosts: DispatchHostView[];
  jobs: DispatchJobView[];
  sessions: DispatchSessionView[];
  concurrency: number | null;
  error: string | null;
};

vi.mock("@/hooks/use-dispatch-state", () => ({
  useDispatchState: () => ({
    ...dispatchState,
    isSubmitting: false,
    setError: vi.fn(),
    enqueue,
    cancel,
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
    issueNumber: 1049,
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

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1049",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1049,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-08-14T00:00:00Z",
    lastReportedAt: "2026-08-14T00:05:00Z",
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1049,
    title: "WSL実行時のクイックスタート機能の追加",
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
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1049",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

function label(name: string): IssueLabel {
  return { name, color: "#000000", description: null } as IssueLabel;
}

function renderButton(
  issue = makeIssue(),
  props: { showStartButton?: boolean; showJobStatus?: boolean; fullWidth?: boolean } = {},
) {
  return render(<StartLocalSessionButton issue={issue} onIssueUpdated={vi.fn()} {...props} />);
}

/** 押せない理由は、PCではボタンを包むspanのtitleに入る（#1468）。 */
function startButtonTitle(): string {
  return (
    screen.getByRole("button", { name: /サブPCで開始/ }).parentElement?.getAttribute("title") ?? ""
  );
}

/**
 * 「このPC」（`issuedeck://`）は#1263で廃止したため、このコンポーネントはサブPCへの起動と
 * 積んだジョブの状態表示だけを持つ。
 */
describe("StartLocalSessionButton", () => {
  beforeEach(() => {
    dispatchState = { hosts: [], jobs: [], sessions: [], concurrency: 2, error: null };
  });

  afterEach(() => {
    cleanup();
    updateIssue.mockReset();
    enqueue.mockReset();
    cancel.mockReset();
  });

  describe("導線を出す条件", () => {
    it("申告しているサブPCが無ければ導線ごと出さない", () => {
      const { container } = renderButton();
      expect(container.firstChild).toBeNull();
    });

    it("申告があれば出す（マーカー行の有無は問わない・#1224）", () => {
      dispatchState.hosts = [makeHost()];
      renderButton();
      expect(screen.getByRole("button", { name: /サブPCで開始/ })).not.toBeNull();
    });

    it("closeされたIssueでは出さない（起動しても実装対象が無いため）", () => {
      dispatchState.hosts = [makeHost()];
      const { container } = renderButton(makeIssue({ state: "closed" }));
      expect(container.firstChild).toBeNull();
    });

    it("リポジトリ名が壊れていれば出さない", () => {
      dispatchState.hosts = [makeHost()];
      const { container } = renderButton(makeIssue({ repositoryFullName: "invalid" }));
      expect(container.firstChild).toBeNull();
    });
  });

  describe("起動先の選択", () => {
    // 選択肢が1つしか無いメニューを開かせない
    it("サブPCが1台ならメニューではなく単独のボタンにする", async () => {
      dispatchState.hosts = [makeHost()];
      enqueue.mockResolvedValue(true);
      renderButton();

      fireEvent.click(screen.getByRole("button", { name: /サブPCで開始/ }));
      await waitFor(() => expect(enqueue).toHaveBeenCalled());
    });

    it("サブPCが2台以上ならメニューにする", () => {
      dispatchState.hosts = [makeHost(), makeHost({ name: "subpc2" })];
      renderButton();

      expect(screen.getByRole("button", { name: /サブPCで開始/ })).not.toBeNull();
    });

    // #1468。PCのツールバーでは本文がボタン列を縦に膨らませるためtitleへ寄せた
    it("応答していないサブPCではボタンを押せず、理由をtitleで出す（PC）", () => {
      dispatchState.hosts = [makeHost({ online: false })];
      renderButton();

      expect(screen.getByRole("button", { name: /サブPCで開始/ }).hasAttribute("disabled")).toBe(
        true,
      );
      expect(screen.queryByText(/応答していません/)).toBeNull();
      expect(startButtonTitle()).toMatch(/応答していません/);
    });

    // スマホにホバーが無い以上、titleへ寄せると理由を読む手段が無くなる
    it("縦積み（スマホ）では理由を本文で出す", () => {
      dispatchState.hosts = [makeHost({ online: false })];
      renderButton(makeIssue(), { fullWidth: true });

      expect(screen.getByText(/応答していません/)).not.toBeNull();
    });

    it("そのリポジトリを実行できないサブPCは選べない", () => {
      dispatchState.hosts = [makeHost({ repositories: ["guchi-apps/other"] })];
      renderButton();

      expect(screen.getByRole("button", { name: /サブPCで開始/ }).hasAttribute("disabled")).toBe(
        true,
      );
    });
  });

  describe("11.localの付け方", () => {
    it("積めたら11.localを付ける", async () => {
      dispatchState.hosts = [makeHost()];
      enqueue.mockResolvedValue(true);
      renderButton();

      fireEvent.click(screen.getByRole("button", { name: /サブPCで開始/ }));
      await waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(1));
      expect(updateIssue.mock.calls[0][0].labels).toContain("11.local");
    });

    it("積めなかった場合は付けない（無人実行まで触れなくなるため）", async () => {
      dispatchState.hosts = [makeHost()];
      enqueue.mockResolvedValue(false);
      renderButton();

      fireEvent.click(screen.getByRole("button", { name: /サブPCで開始/ }));
      await waitFor(() => expect(enqueue).toHaveBeenCalled());
      expect(updateIssue).not.toHaveBeenCalled();
    });

    it("既に付いていればラベル更新はしない", async () => {
      dispatchState.hosts = [makeHost()];
      enqueue.mockResolvedValue(true);
      renderButton(makeIssue({ labels: [label("11.local")] }));

      fireEvent.click(screen.getByRole("button", { name: /サブPCで開始/ }));
      await waitFor(() => expect(enqueue).toHaveBeenCalled());
      expect(updateIssue).not.toHaveBeenCalled();
    });
  });

  // #1311。起動済みのIssueをもう一度積んでも、poller側で見送られるだけで何も起きない
  describe("起動済み（セッション生存中）のIssue", () => {
    it("ボタンを押せず、セッション名と畳み方をtitleで出す（PC）", () => {
      dispatchState.hosts = [makeHost()];
      dispatchState.sessions = [makeSession()];
      renderButton();

      const button = screen.getByRole("button", { name: /サブPCで開始/ });
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(startButtonTitle()).toMatch(/issue-deck-issue-1049/);
      expect(startButtonTitle()).toMatch(/kill-session/);
    });

    // 死んだペインのセッションはstart-issue.shが畳んで作り直す。止めると起動できなくなる
    it("終了したセッションしか無ければ従来どおり押せる", () => {
      dispatchState.hosts = [makeHost()];
      dispatchState.sessions = [makeSession({ state: "EXITED" })];
      renderButton();

      expect(
        screen.getByRole("button", { name: /サブPCで開始/ }).hasAttribute("disabled"),
      ).toBe(false);
    });

    // pollerが落ちている間、行はALIVEのまま古びる。報告が無いことと「動いている」ことは違う
    it("報告が途絶えたホストのセッションでは塞がない", () => {
      dispatchState.hosts = [makeHost({ online: false })];
      dispatchState.sessions = [makeSession()];
      renderButton();

      // 押せないこと自体は変わらないが、理由はホストの応答（従来どおり）になる
      expect(startButtonTitle()).toMatch(/応答していません/);
      expect(startButtonTitle()).not.toMatch(/kill-session/);
    });
  });

  describe("積んだ結果の表示", () => {
    it("未完了のジョブは状態と取り消しを出す", () => {
      dispatchState.hosts = [makeHost()];
      dispatchState.jobs = [makeJob()];
      renderButton();

      expect(screen.getByText(/順番待ち/)).not.toBeNull();
    });

    it("失敗したジョブは理由を本文として出す（スマホではホバーできない）", () => {
      dispatchState.hosts = [makeHost()];
      dispatchState.jobs = [
        makeJob({
          status: "FAILED",
          message: "start-issue.sh が見つかりません",
          finishedAt: "2026-08-14T00:05:00Z",
        }),
      ];
      renderButton();

      expect(screen.getByText(/サブPCで失敗/)).not.toBeNull();
      expect(screen.getByText("start-issue.sh が見つかりません")).not.toBeNull();
    });

    // #1468。PCのIssue詳細では、親がツールバーの下の行に自分で描画する
    it("showJobStatus={false}なら状態を出さない（親が別の行に出すため）", () => {
      dispatchState.hosts = [makeHost()];
      dispatchState.jobs = [makeJob()];
      renderButton(makeIssue(), { showJobStatus: false });

      expect(screen.queryByText(/順番待ち/)).toBeNull();
      expect(screen.getByRole("button", { name: /サブPCで開始/ })).not.toBeNull();
    });
  });

  // #1349。「実装を開始」のトリガーは既定の実行先を文言にしている（#1262）ため、同じ画面に
  // 両方出すと「サブPCで開始」が2つ並ぶ
  describe("起動ボタンを出さない場合（showStartButton={false}）", () => {
    it("起動ボタンを出さない", () => {
      dispatchState.hosts = [makeHost()];
      renderButton(makeIssue(), { showStartButton: false });

      expect(screen.queryByRole("button", { name: /サブPCで開始/ })).toBeNull();
    });

    it("サブPCが2台以上でも起動先のメニューを出さない", () => {
      dispatchState.hosts = [makeHost(), makeHost({ name: "subpc2" })];
      renderButton(makeIssue(), { showStartButton: false });

      expect(screen.queryByRole("button", { name: /サブPCで開始/ })).toBeNull();
    });

    // このコンポーネントが残っている理由（#1248）。ダイアログは積んだ時点で閉じる
    it("積んだジョブの状態は変わらず出す", () => {
      dispatchState.hosts = [makeHost()];
      dispatchState.jobs = [makeJob()];
      renderButton(makeIssue(), { showStartButton: false });

      expect(screen.getByText(/順番待ち/)).not.toBeNull();
    });

    // 押す相手がいない以上、「押せない理由」だけが残ると何のことか分からない
    it("押せない理由は出さない", () => {
      dispatchState.hosts = [makeHost({ online: false })];
      renderButton(makeIssue(), { showStartButton: false });

      expect(screen.queryByText(/応答していません/)).toBeNull();
    });
  });
});
