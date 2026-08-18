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
    dispatchRunnable: false,
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
    manualStepCapable: null,
    manualStepAbortCapable: null,
    planReviewCapable: null,
    selfUpdateCapable: null,
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

const OTHER_REPOSITORY_FULL_NAME = "guchi-apps/shopping-list";

function makeOtherRepository(): ConnectedRepository {
  return {
    ...makeRepository(),
    id: "2",
    name: "shopping-list",
    fullName: OTHER_REPOSITORY_FULL_NAME,
  };
}

/** 実際の利用と同じく、開閉状態を呼び出し側（issue-deck-shell）が持つ形で描画する */
function Harness({
  onCreated,
  repositories = [makeRepository()],
  defaultRepositoryFullName = REPOSITORY_FULL_NAME,
}: {
  onCreated: (issue: Issue) => void;
  repositories?: ConnectedRepository[];
  defaultRepositoryFullName?: string | null;
}) {
  const [open, setOpen] = useState(true);
  return (
    <CreateIssueDialog
      open={open}
      onOpenChange={setOpen}
      repositories={repositories}
      defaultRepositoryFullName={defaultRepositoryFullName}
      issues={[]}
      onCreated={onCreated}
    />
  );
}

/** 推定を挟まず従来のフォーム（確認ステップ）へ進む（#1605） */
function goToConfirmStep() {
  fireEvent.click(screen.getByRole("button", { name: "自分で入力する" }));
}

/**
 * Radixの`Select`はjsdomに無いポインタ関連のAPIを呼ぶため、開くには先に補う必要がある。
 * 入力ステップのリポジトリ欄（#1733）を実際に操作するテストで使う。
 */
function stubPointerApisForSelect() {
  const proto = Element.prototype as unknown as Record<string, () => unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => undefined;
  proto.releasePointerCapture = () => undefined;
  proto.scrollIntoView = () => undefined;
}

/** 入力ステップのリポジトリ欄で指定する（#1733） */
function pickInputRepository(optionName: string) {
  stubPointerApisForSelect();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "リポジトリ" }), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
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

  it("開いた直後はタイトル・ラベル・担当者を出さない（リポジトリは先に指定できる・#1733）", () => {
    render(<Harness onCreated={vi.fn()} defaultRepositoryFullName={null} />);

    expect(screen.getByLabelText("内容")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "リポジトリ" }).textContent).toContain(
      "自動で決める",
    );
    expect(screen.queryByLabelText("タイトル")).toBeNull();
    expect(screen.queryByLabelText("担当者")).toBeNull();
    expect(screen.queryByRole("button", { name: "作成" })).toBeNull();
  });

  /**
   * #1733。リポジトリ別の画面から渡された値は、これまで入力ステップに何も出ないまま
   * 持ち越され、確認ステップの「表示中のリポジトリ」で初めて分かる状態だった。
   */
  it("リポジトリ別の画面から開いたときは、入力ステップにその値が入っている", () => {
    render(<Harness onCreated={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "リポジトリ" }).textContent).toContain(
      REPOSITORY_FULL_NAME,
    );
  });

  it("指定しなければ、推定に「指定済み」を立てない", async () => {
    quickGenerate.mockResolvedValue({
      repositoryFullName: REPOSITORY_FULL_NAME,
      repositoryCandidates: [REPOSITORY_FULL_NAME],
      title: "タイトル案",
      labels: [],
    });
    render(<Harness onCreated={vi.fn()} defaultRepositoryFullName={null} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(quickGenerate).toHaveBeenCalledTimes(1));
    expect(quickGenerate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ repositoryFullName: null, repositoryPinned: false }),
    );
  });

  /**
   * #1733。人が選んだ値を推し量る意味は無いので、リポジトリの推定は省く。
   * 押しても変わらない候補チップも、直していないのに「自動」と名乗るバッジも出さない。
   */
  it("入力ステップで指定すると、推定を省いて候補チップも「自動」バッジも出さない", async () => {
    quickGenerate.mockResolvedValue({
      repositoryFullName: OTHER_REPOSITORY_FULL_NAME,
      repositoryCandidates: [],
      title: "タイトル案",
      labels: [],
    });
    render(
      <Harness
        onCreated={vi.fn()}
        repositories={[makeRepository(), makeOtherRepository()]}
        defaultRepositoryFullName={null}
      />,
    );

    pickInputRepository(OTHER_REPOSITORY_FULL_NAME);
    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(quickGenerate).toHaveBeenCalledTimes(1));
    expect(quickGenerate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        repositoryFullName: OTHER_REPOSITORY_FULL_NAME,
        repositoryPinned: true,
      }),
    );

    await waitFor(() => expect(screen.queryByLabelText("タイトル")).not.toBeNull());
    // 指定したリポジトリのまま。タイトルだけが「自動」で、リポジトリには何も付かない
    expect(screen.getByLabelText("リポジトリ").textContent).toContain(OTHER_REPOSITORY_FULL_NAME);
    expect(screen.getAllByText("自動")).toHaveLength(1);
    expect(screen.queryByText("表示中のリポジトリ")).toBeNull();
    expect(screen.queryByRole("button", { name: /候補1/ })).toBeNull();
  });

  /**
   * #1733。質問へ切り替えると、ワークフロー未導入のリポジトリは選び直される（#1641）。
   * **選び直された値は本人の指定ではない**ので、指定として扱って推定を省いてはいけない。
   */
  it("種別の切り替えでリポジトリが選び直されたら、指定として扱わない", async () => {
    const unregistered: ConnectedRepository = {
      ...makeOtherRepository(),
      id: "3",
      name: "vps",
      fullName: "guchi-apps/vps",
      hasClaudeWorkflow: false,
    };
    quickGenerate.mockResolvedValue({
      repositoryFullName: REPOSITORY_FULL_NAME,
      repositoryCandidates: [REPOSITORY_FULL_NAME],
      title: null,
      labels: [],
    });
    render(
      <Harness
        onCreated={vi.fn()}
        repositories={[makeRepository(), unregistered]}
        defaultRepositoryFullName={null}
      />,
    );

    pickInputRepository("guchi-apps/vps");
    fireEvent.click(screen.getByRole("button", { name: "質問" }));
    // 質問では選べないため導入済みの先頭へ寄る（#1641）
    expect(screen.getByRole("combobox", { name: "リポジトリ" }).textContent).toContain(
      REPOSITORY_FULL_NAME,
    );

    fireEvent.change(screen.getByLabelText("質問内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(quickGenerate).toHaveBeenCalledTimes(1));
    expect(quickGenerate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ repositoryPinned: false }),
    );
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

  /**
   * #1710。推定を1件に決め打ちしていたため、外したときの直し方が十数件のリストを開くしか
   * なかった。候補を並べ、1タップで選び直せること・押した後は「自動」を名乗らないことを見る。
   */
  it("推定したリポジトリ候補をチップで並べ、押すと選び直せる", async () => {
    quickGenerate.mockResolvedValue({
      repositoryFullName: REPOSITORY_FULL_NAME,
      repositoryCandidates: [REPOSITORY_FULL_NAME, OTHER_REPOSITORY_FULL_NAME],
      title: "タイトル案",
      labels: [],
    });
    render(
      <Harness
        onCreated={vi.fn()}
        repositories={[makeRepository(), makeOtherRepository()]}
        defaultRepositoryFullName={null}
      />,
    );

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    const candidate = await screen.findByRole("button", { name: /候補2.*shopping-list/ });
    expect(
      screen.getByRole("button", { name: /候補1.*issue-deck/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    // リポジトリとタイトルの2つが「自動」
    expect(screen.getAllByText("自動")).toHaveLength(2);

    fireEvent.click(candidate);

    expect(candidate.getAttribute("aria-pressed")).toBe("true");
    // 人が選んだので「自動」は外れる（タイトルの分だけが残る）
    expect(screen.getAllByText("自動")).toHaveLength(1);
  });

  it("リポジトリ別の画面から開いたときは、その値を選んだまま「表示中のリポジトリ」と示す", async () => {
    quickGenerate.mockResolvedValue({
      repositoryFullName: OTHER_REPOSITORY_FULL_NAME,
      repositoryCandidates: [REPOSITORY_FULL_NAME],
      title: "タイトル案",
      labels: [],
    });
    render(
      <Harness
        onCreated={vi.fn()}
        repositories={[makeRepository(), makeOtherRepository()]}
        defaultRepositoryFullName={OTHER_REPOSITORY_FULL_NAME}
      />,
    );

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(screen.queryByText("表示中のリポジトリ")).not.toBeNull());
    expect(
      screen.getByRole("button", { name: /表示中.*shopping-list/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    // 内容から推定した方も、押せば切り替わる候補として並ぶ
    expect(screen.getByRole("button", { name: /候補1.*issue-deck/ })).not.toBeNull();
  });

  it("ラベルが1つも決まらなかったときは、その旨を出す", async () => {
    quickGenerate.mockResolvedValue({
      repositoryFullName: REPOSITORY_FULL_NAME,
      repositoryCandidates: [REPOSITORY_FULL_NAME],
      title: "タイトル案",
      labels: [],
    });
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() =>
      expect(screen.queryByText("ラベルは自動で決められませんでした。選ぶか、生成し直せます。")).not.toBeNull(),
    );
  });

  it("ラベルが決まったときは、その注記を出さない", async () => {
    quickGenerate.mockResolvedValue({
      repositoryFullName: REPOSITORY_FULL_NAME,
      repositoryCandidates: [REPOSITORY_FULL_NAME],
      title: "タイトル案",
      labels: ["30.bug"],
    });
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(screen.queryByText("30.bug")).not.toBeNull());
    expect(
      screen.queryByText("ラベルは自動で決められませんでした。選ぶか、生成し直せます。"),
    ).toBeNull();
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

/**
 * #1728。書いている内容ごと別ウィンドウ（`/issues/new`）へ移す。
 * 移す入口はこのダイアログの中だけで、外枠を差し替えたものが別ウィンドウのページ本体になる。
 */
describe("CreateIssueDialog の別ウィンドウ", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("「別ウィンドウで開く」で、書いている内容を渡してウィンドウを開き、ダイアログを閉じる", () => {
    const open = vi.spyOn(window, "open").mockReturnValue({ focus: vi.fn() } as unknown as Window);
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "書きかけの本文" } });
    fireEvent.click(screen.getByRole("button", { name: "別ウィンドウで開く" }));

    expect(open).toHaveBeenCalledWith(
      "/issues/new",
      "issue-deck-create-issue",
      expect.stringContaining("popup=yes"),
    );
    // 渡すのは入力内容そのもの。開いた側が読み取って消す
    const handoff = JSON.parse(window.localStorage.getItem("issue-create-handoff") ?? "{}");
    expect(handoff.body).toBe("書きかけの本文");
    expect(handoff.repositoryFullName).toBe(REPOSITORY_FULL_NAME);
    expect(handoff.step).toBe("input");
    // 移したのでダイアログ側は閉じる
    expect(screen.queryByLabelText("内容")).toBeNull();
  });

  it("ブラウザに止められた場合はダイアログを閉じず、理由を出す", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "書きかけの本文" } });
    fireEvent.click(screen.getByRole("button", { name: "別ウィンドウで開く" }));

    expect(
      screen.queryByText("ブラウザが別ウィンドウを止めました。このサイトのポップアップを許可してください。"),
    ).not.toBeNull();
    // 書いていた内容の行き先が消えないよう、ダイアログは開いたまま
    expect((screen.getByLabelText("内容") as HTMLTextAreaElement).value).toBe("書きかけの本文");
    expect(window.localStorage.getItem("issue-create-handoff")).toBeNull();
  });

  it("別ウィンドウ側は、移してきた内容と続きのステップで始まる", () => {
    render(
      <CreateIssueDialog
        open
        presentation="window"
        onOpenChange={vi.fn()}
        repositories={[makeRepository()]}
        issues={[]}
        onCreated={vi.fn()}
        initialHandoff={{
          kind: "issue",
          repositoryFullName: REPOSITORY_FULL_NAME,
          title: "移してきたタイトル",
          body: "移してきた本文",
          selectedLabels: ["50.feature"],
          assignee: "m-guchi",
          bodyPrefix: null,
          step: "confirm",
          savedAt: Date.now(),
        }}
      />,
    );

    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("移してきたタイトル");
    expect(screen.getByText("移してきた本文")).not.toBeNull();
    // 移した先で同じ物をもう一度「復元する」と出さない（すでに入っているため）
    expect(screen.queryByText("保存された下書きがあります")).toBeNull();
    // ウィンドウの中には移す先が無いので、「別ウィンドウで開く」は出さない
    expect(screen.queryByRole("button", { name: "別ウィンドウで開く" })).toBeNull();
  });

  it("別ウィンドウでは、取り消しの文言を渡されたものに差し替える", () => {
    render(
      <CreateIssueDialog
        open
        presentation="window"
        onOpenChange={vi.fn()}
        repositories={[makeRepository()]}
        issues={[]}
        onCreated={vi.fn()}
        cancelLabel="デッキへ戻る"
      />,
    );

    expect(screen.getByRole("button", { name: "デッキへ戻る" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "キャンセル" })).toBeNull();
  });
});

/**
 * #1745。1段目で本文テンプレート（機能追加・改善／見た目・不具合）を選べるようにしたもの。
 * 入るのは見出しだけの骨組みで、入力欄は1つのまま。
 */
describe("CreateIssueDialog の本文テンプレート", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  function bodyValue() {
    return (screen.getByLabelText("内容") as HTMLTextAreaElement).value;
  }

  function nextButton() {
    return screen.getByRole("button", { name: "次へ" }) as HTMLButtonElement;
  }

  it("チップを押すと本文に見出しが入り、埋めるまで「次へ」を押せない", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "機能追加" }));

    expect(bodyValue()).toContain("## 追加したい機能");
    expect(bodyValue()).toContain("## なぜ追加したいか（解決したいこと）");
    expect(nextButton().disabled).toBe(true);
    expect(screen.queryByText("テンプレートの項目を埋めると「次へ」が押せます。")).not.toBeNull();
  });

  it("項目を1つ埋めると「次へ」が押せる", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "不具合" }));
    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: `${bodyValue()}\n件数の表示が合っていない` },
    });

    expect(nextButton().disabled).toBe(false);
    expect(screen.queryByText("テンプレートの項目を埋めると「次へ」が押せます。")).toBeNull();
  });

  it("骨組みのままなら、別のチップを押しても確認せず入れ替える", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "機能追加" }));
    fireEvent.click(screen.getByRole("button", { name: "改善・見た目" }));

    expect(bodyValue()).toContain("## 対象の画面・機能");
    expect(bodyValue()).not.toContain("## 追加したい機能");
    expect(screen.getByRole("button", { name: "改善・見た目" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("書いた内容があるときは確認を出し、「やめる」で本文を残す", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "書きかけの本文" } });
    fireEvent.click(screen.getByRole("button", { name: "不具合" }));

    expect(bodyValue()).toBe("書きかけの本文");
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));

    expect(bodyValue()).toBe("書きかけの本文");
    expect(screen.getByRole("button", { name: "不具合" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("確認で「置き換える」を押したときだけ本文を入れ替える", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "書きかけの本文" } });
    fireEvent.click(screen.getByRole("button", { name: "不具合" }));
    fireEvent.click(screen.getByRole("button", { name: "置き換える" }));

    expect(bodyValue()).toContain("## 起きていること");
    expect(bodyValue()).not.toContain("書きかけの本文");
  });

  it("選択中のチップを押し直すと選択が外れ、骨組みのままなら本文も空へ戻る", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "機能追加" }));
    fireEvent.click(screen.getByRole("button", { name: "機能追加" }));

    expect(bodyValue()).toBe("");
    expect(screen.getByRole("button", { name: "機能追加" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("押し直しで外すとき、書いた内容は消さない", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "機能追加" }));
    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: `${bodyValue()}\nカンバンに件数を出したい` },
    });
    fireEvent.click(screen.getByRole("button", { name: "機能追加" }));

    expect(bodyValue()).toContain("カンバンに件数を出したい");
    expect(screen.getByRole("button", { name: "機能追加" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("種別が「質問」のときはテンプレート欄を出さない", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "質問" }));

    expect(screen.queryByText("テンプレート")).toBeNull();
    expect(screen.queryByRole("button", { name: "改善・見た目" })).toBeNull();
  });

  it("確認ステップではテンプレート欄を出さない（書く場所は1段目だけ）", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "機能追加" }));
    goToConfirmStep();

    expect(screen.queryByText("テンプレート")).toBeNull();
  });
});
