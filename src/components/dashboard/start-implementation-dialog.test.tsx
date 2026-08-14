// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartImplementationDialog } from "@/components/dashboard/start-implementation-dialog";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
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

// サブPCへのディスパッチ（#1179）の状態。既定は「申告しているホストが無い」
let dispatchState: {
  hosts: DispatchHostView[];
  jobs: DispatchJobView[];
  concurrency: number | null;
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
  } = {},
) {
  return render(
    <StartImplementationDialog
      issue={props.issue ?? makeIssue()}
      onIssueUpdated={vi.fn()}
      onCommentCreated={vi.fn()}
      open
      onOpenChange={vi.fn()}
      includeDispatchTargets={props.includeDispatchTargets}
      actionsDisabledReason={props.actionsDisabledReason ?? null}
    />,
  );
}

function clickStart() {
  fireEvent.click(screen.getByRole("button", { name: "開始する" }));
}

describe("StartImplementationDialog", () => {
  beforeEach(() => {
    dispatchState = { hosts: [], jobs: [], concurrency: 2, error: null };
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

  it("申告しているホストが無ければ、実行先を選ばせる設定でも選択欄を出さない", () => {
    renderDialog({ includeDispatchTargets: true });

    expect(screen.queryByText("実行先")).toBeNull();
  });

  it("申告があれば実行先を選べ、既定はサブPC（#1262）", () => {
    dispatchState.hosts = [makeHost()];
    renderDialog({ includeDispatchTargets: true });

    expect(screen.getByRole("radio", { name: /subpc/ }).getAttribute("aria-checked")).toBe("true");
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

    expect(screen.getByText("issue-deckの自動化workflowが見つかりません")).toBeTruthy();
    expect((screen.getByRole("button", { name: "開始する" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("サブPCを選ぶとジョブを積み、11.localを付け、@claudeコメントは投稿しない", async () => {
    dispatchState.hosts = [makeHost()];
    renderDialog({ includeDispatchTargets: true });

    fireEvent.click(screen.getByRole("radio", { name: /subpc/ }));
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

    fireEvent.click(screen.getByRole("radio", { name: /subpc/ }));
    clickStart();

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("オプションのラベルはサブPC経路でも起動前に付ける", async () => {
    dispatchState.hosts = [makeHost()];
    renderDialog({ includeDispatchTargets: true });

    // チェックボックスの並びはSTART_IMPLEMENTATION_OPTIONSの表示順（先頭が「計画が必要」）
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("radio", { name: /subpc/ }));
    clickStart();

    await waitFor(() => expect(updateIssue).toHaveBeenCalled());
    expect(updateIssue.mock.calls[0][0].labels).toContain(PLAN_REQUIRED_LABEL);
    expect(updateIssue.mock.calls[0][0].labels).not.toContain(LOCAL_LABEL_NAME);
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
  });

  it("実行できないリポジトリのホストは理由を出して選べなくする", () => {
    dispatchState.hosts = [makeHost({ repositories: ["guchi-apps/dayspan"] })];
    renderDialog({ includeDispatchTargets: true });

    const option = screen.getByRole("radio", { name: /subpc/ });
    expect(option.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(/guchi-apps\/issue-deck は subpc で実行できません/),
    ).not.toBeNull();
  });
});
