// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateIssueDialog } from "@/components/dashboard/create-issue-dialog";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

// フックの戻り値は毎レンダー同じ参照を返す（都度 vi.fn() を作ると setError の identity が
// 変わり続け、初期化用のuseEffectが再実行され続けて無限ループになる）
const createIssue = vi.fn();
const updateIssue = vi.fn();
const issueMutations = {
  createIssue,
  updateIssue,
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
const enqueue = vi.fn();
const dispatchState = {
  hosts: [] as DispatchHostView[],
  jobs: [],
  sessions: [],
  concurrency: 2,
  // 最初の取得が終わったか（#1666）。falseの間は実行先・オプションを出さない
  isLoaded: true,
  error: null,
  isSubmitting: false,
  enqueue,
  cancel: vi.fn(),
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

vi.mock("@/hooks/use-issue-suggest", () => ({
  useIssueSuggest: () => ({
    isGenerating: false,
    error: null,
    notConfigured: false,
    generate: vi.fn(),
  }),
}));

// クイック起票の一括推定（#1605）。戻り値の参照を毎レンダー同じに保つため、外に置いた1つを返す
const quickGenerate = vi.fn();
const quickSuggestState = {
  isGenerating: false,
  error: null as string | null,
  notConfigured: false,
  generate: quickGenerate,
};

vi.mock("@/hooks/use-issue-quick-suggest", () => ({
  useIssueQuickSuggest: () => quickSuggestState,
}));

vi.mock("@/hooks/use-progress-status-mutation", () => ({
  useProgressStatusMutation: () => ({ setProgressStatus: vi.fn() }),
}));

vi.mock("@/hooks/use-dispatch-state", () => ({
  useDispatchState: () => dispatchState,
}));

const REPOSITORY_FULL_NAME = "guchi-apps/issue-deck";

function makeRepository(): ConnectedRepository {
  return {
    id: "1",
    name: "issue-deck",
    fullName: REPOSITORY_FULL_NAME,
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    hidden: false,
    favorite: false,
  };
}

function makeHost(): DispatchHostView {
  return {
    name: "subpc",
    repositories: [REPOSITORY_FULL_NAME],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-14T00:00:00Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    checkout: null,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1434,
    title: "スマホでデバイス選択後、選択画面が再度表示される不具合",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: REPOSITORY_FULL_NAME,
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
    htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}/issues/1434`,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

/** 実際の利用と同じく、開閉状態を呼び出し側（issue-deck-shell）が持つ形で描画する */
function Harness({ onCreated }: { onCreated: (issue: Issue) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <CreateIssueDialog
      open={open}
      onOpenChange={setOpen}
      repositories={[makeRepository()]}
      defaultRepositoryFullName={REPOSITORY_FULL_NAME}
      issues={[]}
      onCreated={onCreated}
    />
  );
}

/** 推定を挟まず従来のフォーム（確認ステップ）へ進む（#1605） */
function goToConfirmStep() {
  fireEvent.click(screen.getByRole("button", { name: "自分で入力する" }));
}

describe("CreateIssueDialog の「作成+実装開始」", () => {
  beforeEach(() => {
    dispatchState.hosts = [makeHost()];
    createIssue.mockResolvedValue(makeIssue());
    enqueue.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    createIssue.mockReset();
    updateIssue.mockReset();
    enqueue.mockReset();
    quickGenerate.mockReset();
    quickSuggestState.isGenerating = false;
    quickSuggestState.error = null;
    quickSuggestState.notConfigured = false;
  });

  it("作成フォームには実装オプションのチェックボックスを出さない（#1580）", () => {
    render(<Harness onCreated={vi.fn()} />);
    goToConfirmStep();

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByText("計画が必要")).toBeNull();
    expect(screen.queryByText("アーティファクトで見た目を出す")).toBeNull();
  });

  it("作成後に開く「実装を開始」ダイアログでオプションを選ばせる（#1580）", async () => {
    render(<Harness onCreated={vi.fn()} />);
    goToConfirmStep();

    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "テスト" } });
    fireEvent.click(screen.getByRole("button", { name: "作成+実装開始" }));

    await screen.findByText("実装を開始");
    expect(screen.queryByText("計画が必要")).not.toBeNull();
    // 実行先はサブPCが既定なので、無人実行専用の撮影は出ない（visibleStartImplementationOptions）
    expect(screen.queryByText("アーティファクトで見た目を出す")).not.toBeNull();
  });

  it("サブPCで開始した後、11.localの付与が返ってきても実行先の選択を開き直さない（#1434）", async () => {
    // `11.local`の付与（GitHubへの往復）は、ダイアログが閉じた後に返る
    let resolveUpdate: ((issue: Issue) => void) | undefined;
    updateIssue.mockReturnValue(
      new Promise<Issue>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const onCreated = vi.fn();
    render(<Harness onCreated={onCreated} />);
    goToConfirmStep();

    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "テスト" } });
    fireEvent.click(screen.getByRole("button", { name: "作成+実装開始" }));

    // 作成できた時点で実行先の選択が開く（既定はサブPC）
    await screen.findByText("実装を開始");
    expect(screen.getByRole("radio", { name: /^サブPC/ }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "開始する" }));

    // ジョブを積めた時点で閉じる
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("実装を開始")).toBeNull());

    // 遅れて届いた更新は呼び出し側へ渡すだけで、選択画面は開き直さない
    const updated = makeIssue({ labels: [{ name: LOCAL_LABEL_NAME, color: "e99695" }] as Issue["labels"] });
    resolveUpdate?.(updated);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(updated));
    expect(screen.queryByText("実装を開始")).toBeNull();
  });
});

/**
 * #1641。「リポジトリに質問する」を新規作成ダイアログの種別として統合したもの。
 * 本文欄・画像添付・ラベルはIssueと共有し、種別で変わるのはタイトル・担当者・作成後の動きだけ。
 */
describe("CreateIssueDialog の種別「質問」", () => {
  beforeEach(() => {
    dispatchState.hosts = [makeHost()];
    createIssue.mockResolvedValue(makeIssue({ title: "[質問] 認証の流れを教えて" }));
    commentMutations.createComment.mockResolvedValue({ id: "c1" });
  });

  afterEach(() => {
    cleanup();
    createIssue.mockReset();
    commentMutations.createComment.mockReset();
  });

  function selectQuestion() {
    fireEvent.click(screen.getByRole("button", { name: "質問" }));
  }

  it("質問ではタイトル欄・担当者・「作成+実装開始」を出さない", () => {
    render(<Harness onCreated={vi.fn()} />);
    selectQuestion();
    goToConfirmStep();

    expect(screen.queryByLabelText("タイトル")).toBeNull();
    expect(screen.queryByLabelText("担当者")).toBeNull();
    expect(screen.queryByRole("button", { name: "作成+実装開始" })).toBeNull();
    expect(screen.getByRole("button", { name: "質問する" })).not.toBeNull();
  });

  // 質問でも画像を貼れて`#123`のIssue補完が効くこと（この統合の主目的）
  it("本文の入力欄はIssueと同じもので、画像添付を出す", () => {
    render(<Harness onCreated={vi.fn()} />);
    selectQuestion();

    expect(screen.getByLabelText("質問内容")).not.toBeNull();
    expect(screen.getByRole("button", { name: "画像を添付" })).not.toBeNull();
  });

  it("タイトルは質問文から自動で作り、確認ステップでプレビューとして見せる", () => {
    render(<Harness onCreated={vi.fn()} />);
    selectQuestion();
    goToConfirmStep();

    expect(screen.getByText("質問内容から自動で作られます")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "内容を編集" }));
    fireEvent.change(screen.getByLabelText("質問内容"), {
      target: { value: "認証の流れを教えて" },
    });
    goToConfirmStep();
    expect(screen.getByText("[質問] 認証の流れを教えて")).not.toBeNull();
  });

  it("Issueを作成したうえで、Actionsを起こす質問コメントを投稿する", async () => {
    const onCreated = vi.fn();
    render(<Harness onCreated={onCreated} />);
    selectQuestion();

    fireEvent.change(screen.getByLabelText("質問内容"), {
      target: { value: "認証の流れを教えて" },
    });
    goToConfirmStep();
    fireEvent.click(screen.getByRole("button", { name: "質問する" }));

    await waitFor(() => expect(createIssue).toHaveBeenCalledTimes(1));
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: "[質問] 認証の流れを教えて", assignee: null }),
    );
    await waitFor(() => expect(commentMutations.createComment).toHaveBeenCalledTimes(1));
    expect(commentMutations.createComment.mock.calls[0][0].body).toContain("@claude 質問: ");
    // 投稿したコメントぶんを数えたIssueを呼び出し側へ渡す（一覧のコメント数がずれない）
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ commentCount: 1 })),
    );
  });
});

/**
 * #1605。開いた直後は本文の入力欄だけを出し、「次へ」でリポジトリ・タイトル・ラベルを
 * 推定してから確認ステップへ移る。**推定の成否によらず確認ステップへは必ず進む。**
 */
describe("CreateIssueDialog のクイック起票", () => {
  beforeEach(() => {
    dispatchState.hosts = [makeHost()];
    createIssue.mockResolvedValue(makeIssue());
  });

  afterEach(() => {
    cleanup();
    createIssue.mockReset();
    quickGenerate.mockReset();
    quickSuggestState.isGenerating = false;
    quickSuggestState.error = null;
    quickSuggestState.notConfigured = false;
  });

  it("開いた直後はリポジトリ・タイトル・ラベル・担当者を出さない", () => {
    render(<Harness onCreated={vi.fn()} />);

    expect(screen.getByLabelText("内容")).not.toBeNull();
    expect(screen.queryByLabelText("リポジトリ")).toBeNull();
    expect(screen.queryByLabelText("タイトル")).toBeNull();
    expect(screen.queryByLabelText("担当者")).toBeNull();
    expect(screen.queryByRole("button", { name: "作成" })).toBeNull();
  });

  it("「次へ」で推定を呼び、確認ステップに結果を入れる", async () => {
    quickGenerate.mockResolvedValue({
      repositoryFullName: REPOSITORY_FULL_NAME,
      title: "PWA表示時に画面を更新するボタンを追加する",
      labels: [],
    });
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: "PWAで引っ張っても更新されない" },
    });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(quickGenerate).toHaveBeenCalledTimes(1));
    expect(quickGenerate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ body: "PWAで引っ張っても更新されない", kind: "issue" }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe(
        "PWA表示時に画面を更新するボタンを追加する",
      ),
    );
  });

  it("推定できなくても確認ステップへ進み、自分で入力できる状態にする", async () => {
    quickSuggestState.notConfigured = true;
    quickGenerate.mockResolvedValue(null);
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(screen.queryByLabelText("タイトル")).not.toBeNull());
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "作成" })).not.toBeNull();
  });

  it("「自分で入力する」では推定を呼ばない", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "自分で入力する" }));

    expect(quickGenerate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("タイトル")).not.toBeNull();
  });

  it("本文が空のままでは「次へ」を押せない", () => {
    render(<Harness onCreated={vi.fn()} />);

    expect(
      (screen.getByRole("button", { name: "次へ" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("確認ステップの「内容を編集」で入力ステップへ戻る", async () => {
    quickGenerate.mockResolvedValue({
      repositoryFullName: REPOSITORY_FULL_NAME,
      title: "タイトル案",
      labels: [],
    });
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    await waitFor(() => expect(screen.queryByLabelText("タイトル")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "内容を編集" }));

    expect((screen.getByLabelText("内容") as HTMLTextAreaElement).value).toBe("本文");
    expect(screen.queryByLabelText("タイトル")).toBeNull();
  });
});
