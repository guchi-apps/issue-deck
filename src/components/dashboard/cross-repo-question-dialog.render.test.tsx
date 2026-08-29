// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossRepoQuestionDialog } from "@/components/dashboard/cross-repo-question-dialog";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import type { ConnectedRepository } from "@/types/repository";

// フックの戻り値は毎レンダー同じ参照を返す（都度 vi.fn() を作ると setError の identity が
// 変わり続け、初期化用のuseEffectが再実行され続けて無限ループになる）
const issueMutations = {
  createIssue: vi.fn(),
  isSubmitting: false,
  error: null,
  setError: vi.fn(),
};
const commentMutations = {
  createComment: vi.fn(),
  isSubmitting: false,
  error: null,
  setError: vi.fn(),
};

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => issueMutations,
}));

vi.mock("@/hooks/use-issue-comment-mutations", () => ({
  useIssueCommentMutations: () => commentMutations,
}));

vi.mock("@/hooks/use-issue-repo-meta", () => ({
  useIssueRepoMeta: () => ({ labels: [], assignees: [], isLoading: false }),
}));

// 横断質問（#1454）の実行先はディスパッチの申告から決まる。フックの戻り値は
// 上の2つと同じ理由で毎レンダー同じ参照にする
const dispatchState = {
  hosts: [] as DispatchHostView[],
  jobs: [],
  sessions: [],
  concurrency: 2,
  error: null as string | null,
  setError: vi.fn(),
  isSubmitting: false,
  enqueue: vi.fn(),
  sendSessionControl: vi.fn(),
  cancel: vi.fn(),
};

vi.mock("@/hooks/use-dispatch-state", () => ({
  useDispatchState: () => dispatchState,
}));

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck", "guchi-apps/dayspan"],
    contractVersion: 1,
    online: true,
    lastSeenAt: "2026-08-15T00:00:00Z",
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

function makeQuestionRepository(): ConnectedRepository {
  return {
    id: "2",
    name: "question",
    fullName: "guchi-apps/question",
    private: true,
    archived: false,
    // 横断質問はActionsを使わないため、ワークフローが無くても記録先に選べる
    hasClaudeWorkflow: false,
    hasLocalStartScript: false,
    dispatchRunnable: false,
    hidden: false,
    favorite: false,
  };
}

function makeRepository(): ConnectedRepository {
  return {
    id: "1",
    name: "issue-deck",
    fullName: "guchi-apps/issue-deck",
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    dispatchRunnable: false,
    hidden: false,
    favorite: false,
  };
}

/**
 * #1454。**GitHub Actionsは1リポジトリしかチェックアウトしない**ため、横断質問はサブPCの
 * 質問セッションだけが実行できる。押せない状態は押す前に理由を出す。
 *
 * #1641で単一リポジトリの質問は新規作成ダイアログへ移り、このダイアログは横断専用になった。
 */
describe("CrossRepoQuestionDialog", () => {
  beforeEach(() => {
    dispatchState.hosts = [makeHost()];
    dispatchState.error = null;
  });

  afterEach(() => {
    cleanup();
  });

  function renderDialog(repositories: ConnectedRepository[]) {
    render(
      <CrossRepoQuestionDialog
        open
        onOpenChange={() => {}}
        repositories={repositories}
        issues={[]}
        onCreated={() => {}}
      />,
    );
  }

  it("質問の範囲を選ばせず、常に横断として開く（#1641）", () => {
    renderDialog([makeRepository(), makeQuestionRepository()]);
    expect(screen.getByText("複数リポジトリに質問する")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "1つのリポジトリ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "複数のリポジトリ（横断）" })).toBeNull();
  });

  // 質問でも画像添付・Issue補完を使えるようにするため、入力欄は新規作成ダイアログと同じ部品にした
  it("質問内容の入力欄に「音声入力を整理」と画像添付を表示する（#1641）", () => {
    renderDialog([makeRepository(), makeQuestionRepository()]);
    expect(screen.getByRole("button", { name: /音声入力を整理/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: "画像を添付" })).not.toBeNull();
  });

  it("参照範囲は「サブPCにある全リポジトリ」で、件数を出す", () => {
    renderDialog([makeRepository(), makeQuestionRepository()]);
    expect(screen.getByText(/サブPCにある全リポジトリ（\s*2件）/)).not.toBeNull();
  });

  // pollerはサブPC側の作業ツリーから動くため、更新するのは人の作業になる
  it("横断質問に対応していないpollerでは理由を出して押させない", () => {
    dispatchState.hosts = [makeHost({ crossRepoQuestionCapable: null })];
    renderDialog([makeRepository(), makeQuestionRepository()]);

    expect(screen.getByText(/横断質問に対応していません/)).not.toBeNull();
    const submit = screen.getByRole("button", { name: "質問する" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("申告しているホストが無ければ押させない", () => {
    dispatchState.hosts = [];
    renderDialog([makeRepository(), makeQuestionRepository()]);

    const submit = screen.getByRole("button", { name: "質問する" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  // 記録先は`claude-issue-dispatch.yml`の有無で絞らない（回答するのはActionsではないため）
  it("ワークフローが無いリポジトリも記録先に選べる", () => {
    renderDialog([makeQuestionRepository()]);
    expect(screen.queryByText(/claude-issue-dispatch.ymlが導入されている/)).toBeNull();
  });
});
