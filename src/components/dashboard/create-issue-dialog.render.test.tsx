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

// 割り当て可能なユーザーはテストごとに差し替える（担当者の固定・#1929）
const repoMeta = { labels: [], assignees: [] as string[], isLoading: false };

vi.mock("@/hooks/use-issue-repo-meta", () => ({
  useIssueRepoMeta: () => repoMeta,
}));

// タイトル・ラベルの付与（#1884）。戻り値の参照を毎レンダー同じに保つため、外に置いた1つを返す
const suggestGenerate = vi.fn();
const suggestState = {
  isGenerating: false,
  error: null as string | null,
  notConfigured: false,
  generate: suggestGenerate,
};

vi.mock("@/hooks/use-issue-suggest", () => ({
  useIssueSuggest: () => suggestState,
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

/**
 * Radixの`Select`はjsdomに無いポインタ関連のAPIを呼ぶため、開くには先に補う必要がある。
 * リポジトリ欄を実際に操作するテストで使う。
 */
function stubPointerApisForSelect() {
  const proto = Element.prototype as unknown as Record<string, () => unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => undefined;
  proto.releasePointerCapture = () => undefined;
  proto.scrollIntoView = () => undefined;
}

/** リポジトリ欄で選び直す */
function pickRepository(optionName: string) {
  stubPointerApisForSelect();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "リポジトリ" }), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

function resetSuggest() {
  suggestGenerate.mockReset();
  suggestState.isGenerating = false;
  suggestState.error = null;
  suggestState.notConfigured = false;
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
    resetSuggest();
  });

  it("作成フォームには実装オプションのチェックボックスを出さない（#1580）", () => {
    render(<Harness onCreated={vi.fn()} />);

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByText("計画が必要")).toBeNull();
    expect(screen.queryByText("アーティファクトで見た目を出す")).toBeNull();
  });

  it("作成後に開く「実装を開始」ダイアログでオプションを選ばせる（#1580）", async () => {
    render(<Harness onCreated={vi.fn()} />);

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
    resetSuggest();
  });

  function selectQuestion() {
    fireEvent.click(screen.getByRole("button", { name: "質問" }));
  }

  it("質問ではタイトル欄・担当者・「作成+実装開始」を出さない", () => {
    render(<Harness onCreated={vi.fn()} />);
    selectQuestion();

    expect(screen.queryByLabelText("タイトル")).toBeNull();
    expect(screen.queryByLabelText("担当者")).toBeNull();
    expect(screen.queryByRole("button", { name: "作成+実装開始" })).toBeNull();
    expect(screen.getByRole("button", { name: "質問する" })).not.toBeNull();
  });

  /** 質問のタイトルは質問文から機械生成する。付与ボタンを出す意味が無い（#1884） */
  it("質問では「タイトル・ラベルを付与」を出さない", () => {
    render(<Harness onCreated={vi.fn()} />);
    selectQuestion();

    expect(screen.queryByRole("button", { name: "タイトル・ラベルを付与" })).toBeNull();
    expect(screen.queryByRole("button", { name: "付け直す" })).toBeNull();
  });

  // 質問でも画像を貼れて`#123`のIssue補完が効くこと（この統合の主目的）
  it("本文の入力欄はIssueと同じもので、画像添付を出す", () => {
    render(<Harness onCreated={vi.fn()} />);
    selectQuestion();

    expect(screen.getByLabelText("質問内容")).not.toBeNull();
    expect(screen.getByRole("button", { name: "画像を添付" })).not.toBeNull();
  });

  it("タイトルは質問文から自動で作り、プレビューとして見せる", () => {
    render(<Harness onCreated={vi.fn()} />);
    selectQuestion();

    expect(screen.getByText("質問内容から自動で作られます")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("質問内容"), {
      target: { value: "認証の流れを教えて" },
    });
    expect(screen.getByText("[質問] 認証の流れを教えて")).not.toBeNull();
  });

  it("Issueを作成したうえで、Actionsを起こす質問コメントを投稿する", async () => {
    const onCreated = vi.fn();
    render(<Harness onCreated={onCreated} />);
    selectQuestion();

    fireEvent.change(screen.getByLabelText("質問内容"), {
      target: { value: "認証の流れを教えて" },
    });
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
 * #1884。項目をすべて1画面に並べ、リポジトリは人が選び、タイトル・ラベルは
 * 「タイトル・ラベルを付与」を押したときだけ決まる。2ステップ（#1605）と
 * 内容からのリポジトリ推定（#1710・#1733）は廃止した。
 */
describe("CreateIssueDialog の1画面フォーム", () => {
  beforeEach(() => {
    dispatchState.hosts = [makeHost()];
    createIssue.mockResolvedValue(makeIssue());
  });

  afterEach(() => {
    cleanup();
    createIssue.mockReset();
    resetSuggest();
    repoMeta.assignees = [];
    window.localStorage.clear();
  });

  it("開いた直後から、リポジトリ・タイトル・内容・ラベルがすべて出ている", () => {
    render(<Harness onCreated={vi.fn()} />);

    expect(screen.getByLabelText("リポジトリ")).not.toBeNull();
    expect(screen.getByLabelText("内容")).not.toBeNull();
    expect(screen.getByLabelText("タイトル")).not.toBeNull();
    expect(screen.getByRole("button", { name: /ラベルを選択/ })).not.toBeNull();
    // 2画面ぶんの導線は無くなった
    expect(screen.queryByRole("button", { name: "次へ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "戻る" })).toBeNull();
    expect(screen.queryByRole("button", { name: "自分で入力する" })).toBeNull();
    expect(screen.queryByRole("button", { name: "内容を編集" })).toBeNull();
  });

  /**
   * #1929。**「どこへ」→「何を」→「詳しく」の順に並べる。** 内容の下にあると、付与で
   * 埋まったタイトルを確かめるのに書き終えた本文を越えて下へ探しに行くことになる。
   */
  it("タイトル欄をリポジトリと内容の間に置く", () => {
    render(<Harness onCreated={vi.fn()} />);

    const repository = screen.getByLabelText("リポジトリ");
    const title = screen.getByLabelText("タイトル");
    const body = screen.getByLabelText("内容");

    expect(repository.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /** #1929。貼った画像はサムネイルで見えており、切り替えて確かめる場面が無い */
  it("プレビューへの切り替えは出さず、画像の添付は残す", () => {
    render(<Harness onCreated={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "プレビュー" })).toBeNull();
    expect(screen.getByRole("button", { name: "画像を添付" })).not.toBeNull();
  });

  /** #1929。欄は無くすが、作成するIssueには必ず`m-guchi`が付く */
  it("担当者の選択欄を出さず、作成するIssueにはm-guchiが付く", async () => {
    repoMeta.assignees = ["m-guchi", "someone-else"];
    render(<Harness onCreated={vi.fn()} />);

    expect(screen.queryByLabelText("担当者")).toBeNull();

    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "テスト" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));

    await waitFor(() =>
      expect(createIssue).toHaveBeenCalledWith(expect.objectContaining({ assignee: "m-guchi" })),
    );
  });

  /**
   * #1929。**割り当て可能ユーザーの取得結果に依存させない。** 以前は取得できた一覧に
   * `m-guchi`が居たときだけ入る初期値だったため、欄を消したまま同じ作りにすると、
   * 取得の失敗・遅延がそのまま担当者なしのIssueになり画面から気づけない。
   */
  it("割り当て可能ユーザーを取得できなくても担当者は付く", async () => {
    repoMeta.assignees = [];
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "テスト" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));

    await waitFor(() =>
      expect(createIssue).toHaveBeenCalledWith(expect.objectContaining({ assignee: "m-guchi" })),
    );
  });

  /**
   * 開いて何も書かずにいるあいだは下書きを残さない（#1929）。担当者を状態として持っていた頃は、
   * 開いただけで`m-guchi`が入り「空ではない下書き」として保存され、次に開くと
   * 「保存された下書きがあります」が出ていた。
   */
  it("何も入力していなければ下書きを保存しない", async () => {
    repoMeta.assignees = ["m-guchi"];
    render(<Harness onCreated={vi.fn()} defaultRepositoryFullName={null} />);

    // 自動保存のデバウンス（500ms）を越えるまで待つ
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(window.localStorage.getItem("issue-create-draft")).toBeNull();
  });

  /** #1745で足した本文テンプレートは廃止（#1884） */
  it("本文テンプレートのチップを出さない", () => {
    render(<Harness onCreated={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "機能追加" })).toBeNull();
    expect(screen.queryByRole("button", { name: "改善・見た目" })).toBeNull();
    expect(screen.queryByRole("button", { name: "不具合" })).toBeNull();
  });

  it("開いていた画面のリポジトリが入り、その出どころを示す", () => {
    render(<Harness onCreated={vi.fn()} />);

    expect(screen.getByLabelText("リポジトリ").textContent).toContain(REPOSITORY_FULL_NAME);
    expect(screen.queryByText("表示中のリポジトリ")).not.toBeNull();
  });

  it("開いていた画面のリポジトリが分からなければ、未選択のまま選ばせる", () => {
    render(<Harness onCreated={vi.fn()} defaultRepositoryFullName={null} />);

    expect(screen.getByLabelText("リポジトリ").textContent).toContain("リポジトリを選択");
    expect(screen.queryByText("表示中のリポジトリ")).toBeNull();
  });

  it("人が選び直したリポジトリには「表示中のリポジトリ」を出さない", () => {
    render(
      <Harness onCreated={vi.fn()} repositories={[makeRepository(), makeOtherRepository()]} />,
    );

    pickRepository(OTHER_REPOSITORY_FULL_NAME);

    expect(screen.getByLabelText("リポジトリ").textContent).toContain(OTHER_REPOSITORY_FULL_NAME);
    expect(screen.queryByText("表示中のリポジトリ")).toBeNull();
  });

  /** #1884。押しただけで選んでいないリポジトリが入る経路を残さない */
  it("質問へ切り替えたとき、質問に使えないリポジトリなら未選択へ戻して選ばせる", () => {
    const notConfigured: ConnectedRepository = {
      ...makeOtherRepository(),
      hasClaudeWorkflow: false,
    };
    render(
      <Harness
        onCreated={vi.fn()}
        repositories={[makeRepository(), notConfigured]}
        defaultRepositoryFullName={OTHER_REPOSITORY_FULL_NAME}
      />,
    );

    expect(screen.getByLabelText("リポジトリ").textContent).toContain(OTHER_REPOSITORY_FULL_NAME);
    fireEvent.click(screen.getByRole("button", { name: "質問" }));

    expect(screen.getByLabelText("リポジトリ").textContent).toContain("リポジトリを選択");
  });

  it("開いただけでは自動生成を呼ばない", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });

    expect(suggestGenerate).not.toHaveBeenCalled();
  });

  it("タイトルが空のあいだは、主ボタンが「タイトル・ラベルを付与」になる", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });

    expect(screen.getByRole("button", { name: "タイトル・ラベルを付与" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "作成" })).toBeNull();
    expect(screen.queryByRole("button", { name: "作成+実装開始" })).toBeNull();
    // 同じことをする口を2つ同時に出さない
    expect(screen.queryByRole("button", { name: "付け直す" })).toBeNull();
  });

  /**
   * #1884。確認ステップにはキャンセルが無かったので、これは並べ替えではなく追加にあたる。
   * スマホの縦積みでは、DOMの先頭に置いたキャンセルが一番下へ回る（`flex-col-reverse`）。
   */
  it("タイトルの有無によらずキャンセルを出し、操作ボタンの先頭に置く", () => {
    render(<Harness onCreated={vi.fn()} />);

    const cancelFirst = () => {
      const footer = screen.getByRole("button", { name: "キャンセル" }).parentElement;
      return Array.from(footer?.querySelectorAll("button") ?? [])[0]?.textContent;
    };
    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    expect(cancelFirst()).toBe("キャンセル");

    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "自分で書いた" } });
    expect(screen.getByRole("button", { name: "キャンセル" })).not.toBeNull();
    expect(cancelFirst()).toBe("キャンセル");
  });

  it("本文が空・リポジトリ未選択のあいだは付与を押せない", () => {
    render(<Harness onCreated={vi.fn()} defaultRepositoryFullName={null} />);

    const button = () => screen.getByRole("button", { name: "タイトル・ラベルを付与" });
    expect((button() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    // 本文が入ってもリポジトリが決まらなければ押せない（ラベルの取得先が無い）
    expect((button() as HTMLButtonElement).disabled).toBe(true);

    pickRepository(REPOSITORY_FULL_NAME);
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it("付与を押すと、同じ画面のタイトル・ラベルが埋まって主ボタンが「作成」に変わる", async () => {
    suggestGenerate.mockResolvedValue({ title: "タイトル案", labels: ["51.improvement"] });
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "タイトル・ラベルを付与" }));

    await waitFor(() =>
      expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("タイトル案"),
    );
    expect(screen.queryByText("51.improvement")).not.toBeNull();
    expect(screen.getAllByText("自動")).toHaveLength(2);
    // 画面は切り替わらない（本文の入力欄が出たまま）
    expect((screen.getByLabelText("内容") as HTMLTextAreaElement).value).toBe("本文");
    expect(screen.getByRole("button", { name: "作成" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "タイトル・ラベルを付与" })).toBeNull();
  });

  it("タイトルを自分で書いた場合は、付与ではなく「作成」を出す", () => {
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "自分で書いた" } });

    expect(screen.queryByRole("button", { name: "タイトル・ラベルを付与" })).toBeNull();
    expect(screen.getByRole("button", { name: "作成" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "作成+実装開始" })).not.toBeNull();
    // 付け直しはこちらへ移る
    expect(screen.getByRole("button", { name: "付け直す" })).not.toBeNull();
    expect(screen.queryByText("自動")).toBeNull();
  });

  it("「付け直す」でも同じ生成を呼ぶ", async () => {
    suggestGenerate.mockResolvedValue({ title: "付け直したタイトル", labels: [] });
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "自分で書いた" } });
    fireEvent.click(screen.getByRole("button", { name: "付け直す" }));

    await waitFor(() => expect(suggestGenerate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe(
        "付け直したタイトル",
      ),
    );
  });

  /** #1710。空欄と「決められなかった」は見分けが付かない */
  it("ラベルが1つも決まらなかったときは、その旨を出す", async () => {
    suggestGenerate.mockResolvedValue({ title: "タイトル案", labels: [] });
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "タイトル・ラベルを付与" }));

    await waitFor(() =>
      expect(
        screen.queryByText("ラベルは自動で決められませんでした。選ぶか、付け直せます。"),
      ).not.toBeNull(),
    );
  });

  it("生成できなくても、自分で書いて作成できる", async () => {
    suggestState.notConfigured = true;
    suggestGenerate.mockResolvedValue(null);
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });
    fireEvent.click(screen.getByRole("button", { name: "タイトル・ラベルを付与" }));

    await waitFor(() => expect(suggestGenerate).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "自分で書いた" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));

    await waitFor(() => expect(createIssue).toHaveBeenCalledTimes(1));
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: "自分で書いた", repositoryFullName: REPOSITORY_FULL_NAME }),
    );
  });
});

/**
 * #1728。書いている内容ごと別ウィンドウ（`/issues/new`）へ移す。
 * 移す入口はこのダイアログの中だけで、外枠を差し替えたものが別ウィンドウのページ本体になる。
 */
/**
 * #1890。「タイトル・ラベルを付与」の応答に種別が乗る。質問だと判定されても**種別は変えず**、
 * 切り替えるかどうかは押した人が決める。
 */
describe("CreateIssueDialog の質問への切り替え提案", () => {
  beforeEach(() => {
    dispatchState.hosts = [makeHost()];
    createIssue.mockResolvedValue(makeIssue());
  });

  afterEach(() => {
    cleanup();
    createIssue.mockReset();
    resetSuggest();
    window.localStorage.clear();
  });

  async function generateAsQuestion() {
    suggestGenerate.mockResolvedValue({
      kind: "question",
      title: "タイトル案",
      labels: ["51.improvement"],
    });
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "違いはなんですか？" } });
    fireEvent.click(screen.getByRole("button", { name: "タイトル・ラベルを付与" }));

    await waitFor(() => expect(screen.queryByText("内容から質問のようです")).not.toBeNull());
  }

  it("質問だと判定されても種別は変えず、提案だけを出す", async () => {
    await generateAsQuestion();

    // 種別はIssueのまま（質問ならタイトルは入力欄ではなく自動プレビューになる）
    expect(screen.getByRole("button", { name: "Issue" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("タイトル案");
  });

  it("質問と判定されなければ提案を出さない", async () => {
    suggestGenerate.mockResolvedValue({ kind: "issue", title: "タイトル案", labels: [] });
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "並び順を変えたい" } });
    fireEvent.click(screen.getByRole("button", { name: "タイトル・ラベルを付与" }));

    await waitFor(() =>
      expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("タイトル案"),
    );
    expect(screen.queryByText("内容から質問のようです")).toBeNull();
  });

  it("「Issueのままにする」で提案を降ろす。フォームの中身は変わらない", async () => {
    await generateAsQuestion();

    fireEvent.click(screen.getByRole("button", { name: "Issueのままにする" }));

    expect(screen.queryByText("内容から質問のようです")).toBeNull();
    expect(screen.getByRole("button", { name: "Issue" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("タイトル案");
  });

  it("「質問に切り替える」で質問の形になり、「Issueに戻す」で元へ戻る", async () => {
    await generateAsQuestion();

    fireEvent.click(screen.getByRole("button", { name: "質問に切り替える" }));

    expect(screen.getByRole("button", { name: "質問" }).getAttribute("aria-pressed")).toBe("true");
    // タイトルは質問文から作った読み取り専用のプレビューへ変わり、担当者欄は消える
    expect(screen.getByText("[質問] 違いはなんですか？")).not.toBeNull();
    expect(screen.queryByLabelText("担当者")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Issueに戻す" }));

    expect(screen.getByRole("button", { name: "Issue" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("タイトル案");
    expect(screen.queryByText("質問に切り替えました。")).toBeNull();
  });

  it("質問に使えないリポジトリで切り替えたときも、「Issueに戻す」で選び直さずに済む", async () => {
    const notConfigured: ConnectedRepository = {
      ...makeOtherRepository(),
      hasClaudeWorkflow: false,
    };
    suggestGenerate.mockResolvedValue({ kind: "question", title: "タイトル案", labels: [] });
    render(
      <Harness
        onCreated={vi.fn()}
        repositories={[makeRepository(), notConfigured]}
        defaultRepositoryFullName={OTHER_REPOSITORY_FULL_NAME}
      />,
    );

    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "違いはなんですか？" } });
    fireEvent.click(screen.getByRole("button", { name: "タイトル・ラベルを付与" }));
    await waitFor(() => expect(screen.queryByText("内容から質問のようです")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "質問に切り替える" }));
    expect(screen.getByLabelText("リポジトリ").textContent).toContain("リポジトリを選択");

    fireEvent.click(screen.getByRole("button", { name: "Issueに戻す" }));
    expect(screen.getByLabelText("リポジトリ").textContent).toContain(OTHER_REPOSITORY_FULL_NAME);
  });

  /**
   * #1890。判定を起こす「タイトル・ラベルを付与」はフッターにあり、提案は先頭の種別欄の下に出る。
   * ダイアログは中身ごとスクロールするため、寄せないと押した位置からは見えないことがある。
   */
  it("提案を出したら、その位置まで画面を寄せる", async () => {
    const scrollIntoView = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scrollIntoView);

    await generateAsQuestion();

    // scrollIntoViewはpassive effectで呼ばれるため、テキストの描画（generateAsQuestion内のwaitFor）
    // より後のタイミングでコミットされることがある（#2401）。ここもwaitForで待つ
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
    vi.restoreAllMocks();
  });

  it("人が種別を押し直したら提案は降りる", async () => {
    await generateAsQuestion();

    fireEvent.click(screen.getByRole("button", { name: "質問" }));

    expect(screen.queryByText("内容から質問のようです")).toBeNull();
    expect(screen.queryByText("質問に切り替えました。")).toBeNull();
  });
});

describe("CreateIssueDialog の別ウィンドウ", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetSuggest();
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

  it("別ウィンドウ側は、移してきた内容が入った状態で始まる", () => {
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
          savedAt: Date.now(),
        }}
      />,
    );

    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("移してきたタイトル");
    expect((screen.getByLabelText("内容") as HTMLTextAreaElement).value).toBe("移してきた本文");
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
 * #2354。**書いている最中に、人が選んだリポジトリをコードが書き換えない。**
 * 選び直したリポジトリがひとりでに別のものへ変わる、という報告への対処で、フォームの
 * 初期化は「閉じた状態から開いた瞬間」だけに限る。
 */
describe("CreateIssueDialog の選んだリポジトリの保持", () => {
  beforeEach(() => {
    dispatchState.hosts = [makeHost()];
    createIssue.mockResolvedValue(makeIssue());
  });

  afterEach(() => {
    cleanup();
    createIssue.mockReset();
    resetSuggest();
    window.localStorage.clear();
  });

  /** 開いたまま、画面側のリポジトリ（`defaultRepositoryFullName`）だけが変わる状況を作る */
  function ReopenableHarness() {
    const [defaultRepositoryFullName, setDefaultRepositoryFullName] = useState<string | null>(
      REPOSITORY_FULL_NAME,
    );
    return (
      <>
        {/* ダイアログを開いている間は外側がaria-hiddenになるため、roleではなくtestIdで引く */}
        <button
          data-testid="change-default-repository"
          onClick={() => setDefaultRepositoryFullName(OTHER_REPOSITORY_FULL_NAME)}
        >
          画面のリポジトリを変える
        </button>
        <CreateIssueDialog
          open
          onOpenChange={vi.fn()}
          repositories={[makeRepository(), makeOtherRepository()]}
          defaultRepositoryFullName={defaultRepositoryFullName}
          issues={[]}
          onCreated={vi.fn()}
        />
      </>
    );
  }

  it("開いている最中に画面側のリポジトリが変わっても、選んだリポジトリと書いた内容は変わらない", () => {
    render(<ReopenableHarness />);
    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "書きかけの本文" } });

    fireEvent.click(screen.getByTestId("change-default-repository"));

    expect(screen.getByLabelText("リポジトリ").textContent).toContain(REPOSITORY_FULL_NAME);
    expect((screen.getByLabelText("内容") as HTMLTextAreaElement).value).toBe("書きかけの本文");
  });

  it("「タイトル・ラベルを付与」を押しても、選び直したリポジトリは変わらない", async () => {
    suggestGenerate.mockResolvedValue({ kind: "issue", title: "タイトル案", labels: [] });
    render(
      <Harness onCreated={vi.fn()} repositories={[makeRepository(), makeOtherRepository()]} />,
    );
    pickRepository(OTHER_REPOSITORY_FULL_NAME);
    fireEvent.change(screen.getByLabelText("内容"), { target: { value: "本文" } });

    fireEvent.click(screen.getByRole("button", { name: "タイトル・ラベルを付与" }));

    await waitFor(() =>
      expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("タイトル案"),
    );
    expect(screen.getByLabelText("リポジトリ").textContent).toContain(OTHER_REPOSITORY_FULL_NAME);
  });

  it("下書きを復元すると、書いていたときに選んでいたリポジトリに戻る", () => {
    window.localStorage.setItem(
      "issue-create-draft",
      JSON.stringify({
        kind: "issue",
        repositoryFullName: OTHER_REPOSITORY_FULL_NAME,
        title: "",
        body: "書きかけの本文",
        selectedLabels: [],
        assignee: null,
      }),
    );
    render(
      <Harness onCreated={vi.fn()} repositories={[makeRepository(), makeOtherRepository()]} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "復元する" }));

    // 開いていた画面のリポジトリ（REPOSITORY_FULL_NAME）ではなく、書いていたときのものに戻す
    expect(screen.getByLabelText("リポジトリ").textContent).toContain(OTHER_REPOSITORY_FULL_NAME);
    expect((screen.getByLabelText("内容") as HTMLTextAreaElement).value).toBe("書きかけの本文");
  });

  it("連携が外れて選択肢に無い下書きのリポジトリは、開いていた画面のリポジトリへ落とす", () => {
    window.localStorage.setItem(
      "issue-create-draft",
      JSON.stringify({
        kind: "issue",
        repositoryFullName: "guchi-apps/removed",
        title: "",
        body: "書きかけの本文",
        selectedLabels: [],
        assignee: null,
      }),
    );
    render(<Harness onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "復元する" }));

    expect(screen.getByLabelText("リポジトリ").textContent).toContain(REPOSITORY_FULL_NAME);
  });
});
