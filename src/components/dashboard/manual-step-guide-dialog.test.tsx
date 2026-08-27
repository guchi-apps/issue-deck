// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualStepGuideDialog } from "@/components/dashboard/manual-step-guide-dialog";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { ManualStepRunView } from "@/lib/manual-step-run-view";
import type { Issue } from "@/types/issue";

/**
 * 見るのは**案内の運び方**（どの順に何が出るか・押したときに何が呼ばれるか）だけ。
 * 本文の解析そのものは`lib/manual-step-guide.test.ts`が実物の本文で見ている。
 */

const taskList = {
  body: "",
  progress: { completed: 0, total: 0 },
  isToggling: false,
  error: null as string | null,
  toggleTask: vi.fn(),
};
const runManualStep = vi.fn();
const controlManualStepRun = vi.fn();
const issueMutations = {
  updateIssue: vi.fn(),
  isSubmitting: false,
  error: null as string | null,
  setError: vi.fn(),
};

vi.mock("@/hooks/use-issue-task-list", () => ({ useIssueTaskList: () => taskList }));
vi.mock("@/hooks/use-issue-mutations", () => ({ useIssueMutations: () => issueMutations }));
vi.mock("@/hooks/use-manual-step-prerequisites", () => ({
  useManualStepPrerequisites: () => ({ prerequisites: [], summary: null }),
}));
// つまずきの記録（#2299）はIssueコメントに置く。**コメントの取得は差し込む**——
// 差し込まないと、画面が`/api/issues/comments`を叩いてfetchのモックと噛み合わない
const comments = { list: [] as { body: string }[] };
const createComment = vi.fn();
vi.mock("@/hooks/use-issue-comments", () => ({
  useIssueComments: () => ({ comments: comments.list, isLoading: false, error: null }),
}));
vi.mock("@/hooks/use-issue-comment-mutations", () => ({
  useIssueCommentMutations: () => ({
    createComment,
    isSubmitting: false,
    error: null,
  }),
}));

const REPO = "guchi-apps/issue-deck";

const BODY = `## この作業でできるようになること

- 画面に残り時間が出るようになる

## 前提条件

- 実行するデバイス: **サブPC**（メインPCからなら \`ssh subpc\`）
- カレントディレクトリ: \`~/apps/issue-deck\`
- Gitブランチ: \`develop\`

## やること

- [ ] チェックアウトを更新する

    \`\`\`bash
    git pull --ff-only
    \`\`\`

- [ ] pollerを再起動する

## 完了の確認方法

- 遅れが0になっていること
`;

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1823",
    number: 1823,
    title: "[手作業] サブPC: チェックアウトを更新する",
    body: BODY,
    state: "open",
    repositoryFullName: REPO,
    labels: [{ name: "71.manual-step", color: "d876e3", description: null }],
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  } as Issue;
}

/** 代行実行（#1828）の判定材料。**差し込まないと画面が自分で`/api/dispatch`を叩く** */
function dispatchHandle(
  overrides: {
    hosts?: DispatchHostView[];
    jobs?: DispatchJobView[];
    /** 自動実行の状態（#1882）。サーバーが持つものを差し込む */
    manualStepRuns?: ManualStepRunView[];
  } = {},
): DispatchStateHandle {
  return {
    hosts: overrides.hosts ?? [subpcHost()],
    jobs: overrides.jobs ?? [],
    sessions: [],
    manualStepRuns: overrides.manualStepRuns ?? [],
    isSubmitting: false,
    runManualStep,
    controlManualStepRun,
    abortManualStep: vi.fn(),
    cancel: vi.fn(),
  } as unknown as DispatchStateHandle;
}

/** サーバーが持っている自動実行（#1882） */
function manualStepRun(overrides: Partial<ManualStepRunView> = {}): ManualStepRunView {
  return {
    repositoryFullName: REPO,
    issueNumber: 1823,
    issueTitle: "[手作業] サブPC: チェックアウトを更新する",
    issueId: "1823",
    targetHost: "subpc",
    status: "RUNNING",
    pausedReason: null,
    done: 0,
    total: 3,
    currentLine: null,
    currentLabel: null,
    currentJobId: null,
    message: null,
    diagnoseConsent: true,
    startedAt: "2026-08-18T00:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

function subpcHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    online: true,
    manualStepCapable: true,
    manualStepAbortCapable: null,
    repositories: [REPO],
    ...overrides,
  } as DispatchHostView;
}

function manualStepJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: REPO,
    issueNumber: 1823,
    kind: "MANUAL_STEP",
    status: "SUCCEEDED",
    manualStepLine: STEP_LINE,
    targetJobId: null,
    command: "git pull --ff-only",
    exitCode: 0,
    commandOutput: "Already up to date.",
    message: null,
    createdAt: "2026-08-17T00:00:00Z",
    startedAt: "2026-08-17T00:00:01Z",
    finishedAt: "2026-08-17T00:00:03Z",
    ...overrides,
  } as DispatchJobView;
}

/** 本文中の`- [ ] チェックアウトを更新する`の行番号（1始まり） */
const STEP_LINE =
  BODY.split("\n").findIndex((text) => text.includes("チェックアウトを更新する")) + 1;

function renderDialog(
  issues: Issue[],
  queueIds = issues.map((item) => item.id),
  dispatch: DispatchStateHandle = dispatchHandle(),
) {
  const onIssueUpdated = vi.fn();
  render(
    <ManualStepGuideDialog
      queueIds={queueIds}
      issues={issues}
      open
      onOpenChange={vi.fn()}
      onIssueUpdated={onIssueUpdated}
      dispatch={dispatch}
    />,
  );
  return { onIssueUpdated };
}

describe("ManualStepGuideDialog", () => {
  beforeEach(() => {
    taskList.body = BODY;
    taskList.isToggling = false;
    taskList.error = null;
    issueMutations.error = null;
    issueMutations.isSubmitting = false;
    taskList.toggleTask.mockReset();
    runManualStep.mockReset().mockResolvedValue({ ok: true });
    controlManualStepRun.mockReset().mockResolvedValue({ ok: true, run: manualStepRun() });
    issueMutations.updateIssue.mockReset().mockResolvedValue(issue({ state: "closed" }));
  });

  afterEach(() => {
    cleanup();
  });

  it("最初に目的を出し、「はじめる」で手順1へ進む", () => {
    renderDialog([issue()]);

    expect(screen.getByRole("heading", { name: "この作業でできるようになること" })).toBeTruthy();
    expect(screen.getByText("画面に残り時間が出るようになる")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(screen.getByRole("heading", { name: /手順 1 \/ 2/ })).toBeTruthy();
    expect(screen.getByText("チェックアウトを更新する")).toBeTruthy();
  });

  it("実行する場所は目的でも手順でも出したままにする", () => {
    renderDialog([issue()]);

    expect(screen.getByText("サブPC")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    // 手順へ進んでも消えない（手元の端末で打ってしまう事故を防ぐのがこのチップの役目）
    expect(screen.getByText("サブPC")).toBeTruthy();
    expect(screen.getByText("~/apps/issue-deck")).toBeTruthy();
    expect(screen.getByText("develop")).toBeTruthy();
  });

  /**
   * 解析そのものは`lib/manual-step-guide.test.ts`が見ているが、コピーボタン（#1726）が
   * 実際に出るかどうかは描いてみないと分からない。テンプレートの文言（「インデントした
   * コードブロック」）どおりにフェンス無しで書かれた手順で、パーサ → 画面 → ボタンまで通す（#1835）。
   */
  it("インデント記法で書かれた手順のコマンドにもコピーボタンが出る（#1835）", () => {
    taskList.body = `## やること

- [ ] トークンを生成する

      openssl rand -hex 32
`;
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(screen.getByText("openssl rand -hex 32")).toBeTruthy();
    expect(screen.getByRole("button", { name: "コードをコピー" })).toBeTruthy();
  });

  it("「実行した・次へ」でその手順の行にチェックを付ける", () => {
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    fireEvent.click(screen.getByRole("button", { name: "実行した・次へ" }));

    // 本文中の`- [ ] チェックアウトを更新する`の行（1始まり）
    const line = BODY.split("\n").findIndex((text) => text.includes("チェックアウトを更新する")) + 1;
    expect(taskList.toggleTask).toHaveBeenCalledWith(line, true);
  });

  it("「あとで」ではチェックを付けずに次の手順へ進む", () => {
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    fireEvent.click(screen.getByRole("button", { name: "あとで" }));

    expect(taskList.toggleTask).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /手順 2 \/ 2/ })).toBeTruthy();
  });

  it("最後の手順の次は完了の確認とクローズの出口になる", () => {
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    fireEvent.click(screen.getByRole("button", { name: "あとで" }));
    fireEvent.click(screen.getByRole("button", { name: "あとで" }));

    expect(screen.getByText("完了の確認方法")).toBeTruthy();
    expect(screen.getByText("遅れが0になっていること")).toBeTruthy();
    expect(screen.getByRole("button", { name: "完了してクローズ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "実施せずクローズ" })).toBeTruthy();
  });

  it("完了してクローズすると次の手作業へ進む", async () => {
    const second = issue({ id: "1795", number: 1795, title: "[手作業] タグを配る" });
    renderDialog([issue(), second]);

    expect(screen.getByText("1 / 2 件目")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    fireEvent.click(screen.getByRole("button", { name: "あとで" }));
    fireEvent.click(screen.getByRole("button", { name: "あとで" }));
    fireEvent.click(screen.getByRole("button", { name: "完了してクローズ" }));

    expect(issueMutations.updateIssue).toHaveBeenCalledWith({
      repositoryFullName: REPO,
      number: 1823,
      state: "closed",
      stateReason: "completed",
    });
    expect(await screen.findByText("2 / 2 件目")).toBeTruthy();
  });

  it("「この手作業は飛ばす」で次の手作業へ移り、クローズはしない", () => {
    const second = issue({ id: "1795", number: 1795, title: "[手作業] タグを配る" });
    renderDialog([issue(), second]);

    fireEvent.click(screen.getByRole("button", { name: "この手作業は飛ばす" }));

    expect(issueMutations.updateIssue).not.toHaveBeenCalled();
    expect(screen.getByText("2 / 2 件目")).toBeTruthy();
  });

  it("キューを進み切ると完了の画面になる", () => {
    renderDialog([issue()]);

    fireEvent.click(screen.getByRole("button", { name: "この手作業は飛ばす" }));

    expect(screen.getByText("案内する手作業がすべて終わりました。")).toBeTruthy();
  });

  it("テンプレートに沿っていない本文は手順に割らず、本文をそのまま出す", () => {
    taskList.body = "設定画面でトークンを入れ替えてください。";
    renderDialog([issue({ body: taskList.body })]);

    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(screen.getByText(/順番に割れませんでした/)).toBeTruthy();
    expect(screen.getByText("設定画面でトークンを入れ替えてください。")).toBeTruthy();
    // 出口だけは残す（案内できない手作業を行き止まりにしない）
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    expect(screen.getByRole("button", { name: "完了してクローズ" })).toBeTruthy();
  });
});

/**
 * 手作業の代行実行（#1828）。**押す前に何を実行するかが出ていること**と、
 * **代行できないときに理由が出ること**を見る。実行の可否の判定そのものは
 * `lib/dispatch/dispatch-job.ts`と`lib/manual-step-command.ts`のテストが持つ。
 */
describe("ManualStepGuideDialog の代行実行", () => {
  beforeEach(() => {
    taskList.body = BODY;
    taskList.toggleTask.mockReset();
    runManualStep.mockReset().mockResolvedValue({ ok: true });
    controlManualStepRun.mockReset().mockResolvedValue({ ok: true, run: manualStepRun() });
  });

  afterEach(() => {
    cleanup();
  });

  it("実行するコマンドを出したうえで承認を求める", () => {
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(screen.getByText("subpcで代行実行できます")).toBeTruthy();
    expect(screen.getByRole("button", { name: "承認して実行" })).toBeTruthy();
    // 出力の扱いは押す前に伝える（このリポジトリはPUBLIC）
    expect(screen.getByText(/出力にシークレットが混ざることがあります/)).toBeTruthy();
  });

  it("承認すると、その手順の行と本文のコマンドを送る", () => {
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    fireEvent.click(screen.getByRole("button", { name: "承認して実行" }));

    expect(runManualStep).toHaveBeenCalledWith({
      repositoryFullName: REPO,
      issueNumber: 1823,
      hostName: "subpc",
      stepLine: STEP_LINE,
      command: "git pull --ff-only",
    });
  });

  // 終了コード0のときだけ。**画面が進むのではなくチェックが付くだけ**（結果を読む前に進めない）
  it("終了コード0で終わったら手順にチェックを付ける", async () => {
    renderDialog([issue()], undefined, dispatchHandle({ jobs: [manualStepJob()] }));
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(await screen.findByText(/実行しました（終了コード 0）/)).toBeTruthy();
    expect(taskList.toggleTask).toHaveBeenCalledWith(STEP_LINE, true);
  });

  it("失敗したらチェックを付けず、出力を開いて出す", async () => {
    renderDialog(
      [issue()],
      undefined,
      dispatchHandle({
        jobs: [
          manualStepJob({
            status: "FAILED",
            exitCode: 1,
            commandOutput: "error: Your local changes would be overwritten",
          }),
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(screen.getByText(/失敗しました（終了コード 1）/)).toBeTruthy();
    expect(screen.getByText(/error: Your local changes would be overwritten/)).toBeTruthy();
    expect(taskList.toggleTask).not.toHaveBeenCalled();
  });

  // VPS・1Password・GitHub App・ブラウザでの設定はissue-deckから到達できない
  it("サブPC以外で実行する手作業では、ボタンを出さずに理由を出す", () => {
    const body = BODY.replace("**サブPC**", "**VPS**");
    taskList.body = body;
    renderDialog([issue({ body })]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(screen.queryByRole("button", { name: "承認して実行" })).toBeNull();
    expect(screen.getByText(/画面からは代行できません/)).toBeTruthy();
  });

  // pollerはサブPC側の作業ツリーから動くため、更新するのは人の作業になる
  it("pollerが未対応なら理由を出す", () => {
    renderDialog(
      [issue()],
      undefined,
      dispatchHandle({ hosts: [subpcHost({ manualStepCapable: null })] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(screen.queryByRole("button", { name: "承認して実行" })).toBeNull();
    expect(screen.getByText(/代行実行に対応していません/)).toBeTruthy();
  });

  // コマンドが1つに定まらない手順（2つ目の手順にはコードブロックが無い）
  it("コマンドが書かれていない手順では理由を出す", () => {
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    fireEvent.click(screen.getByRole("button", { name: "あとで" }));

    expect(screen.queryByRole("button", { name: "承認して実行" })).toBeNull();
    expect(screen.getByText(/ちょうど1つ書かれている手順だけを代行します/)).toBeTruthy();
  });

  /**
   * 手順ごとのデバイス（#2052）。**チップと代行の可否が同じ手作業の中で切り替わること**を
   * 描いて確かめる。判定そのものは`lib/manual-step-autorun.test.ts`が見ているが、
   * どのステージのデバイスをチップに出すかは画面側の配線なので、ここでしか落ちない。
   */
  it("手順の文頭に書かれた端末でチップと代行の可否が切り替わる（#2052）", () => {
    const body = BODY.replace(
      "- [ ] チェックアウトを更新する",
      "- [ ] （ブラウザ）GitHubの設定画面でトークンを発行する\n\n- [ ] チェックアウトを更新する",
    );
    taskList.body = body;
    renderDialog([issue({ body })]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    // 手順1はブラウザ。既定値がサブPCでも代行しない
    expect(screen.getByText("ブラウザ")).toBeTruthy();
    expect(screen.queryByText("サブPC")).toBeNull();
    expect(screen.queryByRole("button", { name: "承認して実行" })).toBeNull();
    expect(screen.getByText(/ブラウザで実行するため/)).toBeTruthy();

    // 手順2はデバイスが書かれていないので既定値（サブPC）へ落ち、代行できる
    fireEvent.click(screen.getByRole("button", { name: "あとで" }));

    expect(screen.getByText("サブPC")).toBeTruthy();
    expect(screen.getByRole("button", { name: "承認して実行" })).toBeTruthy();
  });
});

/**
 * 自動実行と失敗時の修正案（#1869）。
 *
 * 見るのは**運び方**（承認1回でどこまで進むか・どこで止まるか・修正案をどう適用するか）だけ。
 * 実行計画の組み立ては`lib/manual-step-autorun.test.ts`、診断の解釈は
 * `lib/claude/manual-step-fix.test.ts`が持つ。
 */
describe("ManualStepGuideDialog の自動実行", () => {
  const AUTO_BODY = `## 前提条件

- 実行するデバイス: **サブPC**

## やること

- [ ] チェックアウトを更新する

    \`\`\`bash
    git pull --ff-only
    \`\`\`

- [ ] pollerを再起動する

    \`\`\`bash
    systemctl --user restart issue-deck-poller.service
    \`\`\`

## 完了の確認方法

- 遅れが0であること

    \`\`\`bash
    git rev-list --count HEAD..origin/develop
    \`\`\`
`;
  const lines = AUTO_BODY.split("\n");
  const FIRST_LINE = lines.findIndex((text) => text.includes("チェックアウトを更新する")) + 1;
  const SECOND_LINE = lines.findIndex((text) => text.includes("pollerを再起動する")) + 1;
  const VERIFICATION_LINE =
    lines.findIndex(
      (text, index) => text.trim() === "```bash" && index > SECOND_LINE + 3,
    ) + 1;

  const fetchMock = vi.fn();

  function renderAutoDialog(dispatch: DispatchStateHandle) {
    const view = render(
      <ManualStepGuideDialog
        queueIds={["1823"]}
        issues={[issue({ body: AUTO_BODY })]}
        open
        onOpenChange={vi.fn()}
        onIssueUpdated={vi.fn()}
        dispatch={dispatch}
      />,
    );
    return {
      rerender: (next: DispatchStateHandle) =>
        view.rerender(
          <ManualStepGuideDialog
            queueIds={["1823"]}
            issues={[issue({ body: AUTO_BODY })]}
            open
            onOpenChange={vi.fn()}
            onIssueUpdated={vi.fn()}
            dispatch={next}
          />,
        ),
    };
  }

  beforeEach(() => {
    taskList.body = AUTO_BODY;
    taskList.toggleTask.mockReset();
    runManualStep.mockReset().mockResolvedValue({ ok: true });
    controlManualStepRun.mockReset().mockResolvedValue({ ok: true, run: manualStepRun() });
    issueMutations.updateIssue.mockReset().mockResolvedValue(issue({ body: AUTO_BODY }));
    fetchMock.mockReset();
    comments.list = [];
    createComment.mockReset().mockResolvedValue({ id: "c1" });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("最初の画面に、実行されるコマンドを全部並べて承認を求める", () => {
    renderAutoDialog(dispatchHandle());

    expect(screen.getByText("手順2件・確認1件を続けて実行できます")).toBeTruthy();
    expect(screen.getByText("git pull --ff-only")).toBeTruthy();
    expect(screen.getByText("systemctl --user restart issue-deck-poller.service")).toBeTruthy();
    expect(screen.getByText("git rev-list --count HEAD..origin/develop")).toBeTruthy();
    expect(screen.getByRole("button", { name: "承認して3件を自動実行" })).toBeTruthy();
  });

  // 対話が要るコマンド（#2025）。**その1件だけ人が実行し、残りは承認の対象に残る**
  it("対話が要るコマンドを含む手順は「あなたが実行」として並べる", () => {
    const body = AUTO_BODY.replace(
      "systemctl --user restart issue-deck-poller.service",
      "op signin",
    );
    taskList.body = body;
    render(
      <ManualStepGuideDialog
        queueIds={["1823"]}
        issues={[issue({ body })]}
        open
        onOpenChange={vi.fn()}
        onIssueUpdated={vi.fn()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText("あなたが実行")).toBeTruthy();
    expect(screen.getByText(/対話が必要なコマンド（op signin）/)).toBeTruthy();
    // 残りの手順と確認は代行できるので、承認の対象から外れるのはその1件だけ
    expect(screen.getByRole("button", { name: "承認して2件を自動実行" })).toBeTruthy();
  });

  it("承認するとサーバーへ開始を伝える（画面は積まない。#1882）", () => {
    renderAutoDialog(dispatchHandle());

    fireEvent.click(screen.getByRole("button", { name: "承認して3件を自動実行" }));

    expect(controlManualStepRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: REPO,
        issueNumber: 1823,
        action: "start",
        hostName: "subpc",
        diagnoseConsent: true,
      }),
    );
    // **画面からは1件も積まない。** 積むのはサーバー（両方が積むと同じ手順が二重に走る）
    expect(runManualStep).not.toHaveBeenCalled();
  });

  it("走っている間は進み具合と「閉じても続く」ことを出す（#1882）", () => {
    renderAutoDialog(
      dispatchHandle({
        manualStepRuns: [manualStepRun({ done: 1, total: 3, currentLine: SECOND_LINE })],
      }),
    );

    expect(screen.getByText("自動実行中 2 / 3")).toBeTruthy();
    expect(screen.getByText("・この画面を閉じても続きます")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "中断する" }).length).toBeGreaterThan(0);
  });

  it("中断するとサーバーへ中断を伝える（#1882）", () => {
    renderAutoDialog(dispatchHandle({ manualStepRuns: [manualStepRun({ done: 1 })] }));

    fireEvent.click(screen.getAllByRole("button", { name: "中断する" })[0]);

    expect(controlManualStepRun).toHaveBeenCalledWith(
      expect.objectContaining({ action: "stop", repositoryFullName: REPO, issueNumber: 1823 }),
    );
  });

  it("止まっているときは理由を出し、次を積まない", () => {
    renderAutoDialog(
      dispatchHandle({
        manualStepRuns: [
          manualStepRun({
            status: "PAUSED",
            pausedReason: "FAILED",
            message: "終了コード 1 で終わったため止まりました。",
            done: 1,
          }),
        ],
        jobs: [manualStepJob({ manualStepLine: FIRST_LINE, status: "FAILED", exitCode: 1 })],
      }),
    );

    expect(screen.getByText("失敗したため止まっています")).toBeTruthy();
    expect(screen.getByText("・終了コード 1 で終わったため止まりました。")).toBeTruthy();
    expect(runManualStep).not.toHaveBeenCalled();
  });

  // 帯が出ている間だけダイアログの子が1つ増える。段の数を数える組み方（`grid-rows-*`）へ
  // 戻すと割り当てが1つずつずれ、帯が高さ0まで潰れて読めなくなる（#2402）。
  // **jsdomは高さを持たないため描画のテストでは捕まらない**ので、クラスの並びで見張る
  it("止まっている帯は本文の外に置き、縮むのは本文だけ（#2402）", () => {
    renderAutoDialog(
      dispatchHandle({
        manualStepRuns: [
          manualStepRun({ status: "PAUSED", pausedReason: "FAILED", done: 1 }),
        ],
      }),
    );

    const content = document.querySelector('[data-slot="dialog-content"]');
    const bar = screen.getByText("失敗したため止まっています").closest('[role="status"]');
    expect(content).toBeTruthy();
    expect(bar).toBeTruthy();

    // 高さを配るのはflexの縦積み。段の数を数える組み方へ戻っていない。
    // `DialogContent`の既定の`grid`はtailwind-mergeが落とし、表示は`flex`で確定する
    // （残る`grid-cols-[minmax(0,1fr)]`は効かないので、横幅は`max-w-*`が止める）
    expect(content?.classList.contains("flex")).toBe(true);
    expect(content?.classList.contains("grid")).toBe(false);
    expect(content?.className).toContain("flex-col");
    expect(content?.className).not.toContain("grid-rows-");
    expect(content?.className).toContain("max-w");
    // 帯はスクロール領域の外（本文をスクロールしても隠れない）にあり、縮まない
    expect(bar?.parentElement).toBe(content);
    expect(bar?.className).toContain("shrink-0");
    // 伸縮するのは帯の次に来る本文のスクロール領域だけ
    const body = bar?.nextElementSibling;
    expect(body?.className).toContain("flex-1");
    expect(body?.className).toContain("overflow-y-auto");
  });

  it("人が実行して「実行した・次へ」を押すと、続きから流すようサーバーへ伝える", async () => {
    renderAutoDialog(
      dispatchHandle({
        manualStepRuns: [
          manualStepRun({ status: "PAUSED", pausedReason: "USER", currentLine: FIRST_LINE }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "実行した・次へ" }));

    await vi.waitFor(() =>
      expect(controlManualStepRun).toHaveBeenCalledWith(
        expect.objectContaining({ action: "resume" }),
      ),
    );
    expect(taskList.toggleTask).toHaveBeenCalledWith(FIRST_LINE, true);
  });

  it("自動実行中の成功では画面がチェックを付けない（付けるのはサーバー。#1882）", () => {
    const view = renderAutoDialog(
      dispatchHandle({ manualStepRuns: [manualStepRun({ currentLine: FIRST_LINE })] }),
    );

    view.rerender(
      dispatchHandle({
        manualStepRuns: [manualStepRun({ currentLine: FIRST_LINE })],
        jobs: [manualStepJob({ manualStepLine: FIRST_LINE, exitCode: 0 })],
      }),
    );

    expect(taskList.toggleTask).not.toHaveBeenCalled();
  });

  it("失敗すると原因を調べ、修正案を差分で出す", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        fix: {
          kind: "command",
          cause: "ユニット名が実際と違います。",
          command: "systemctl --user restart issue-deck-dispatch-poller.service",
          advice: null,
        },
        currentCommand: "systemctl --user restart issue-deck-poller.service",
      }),
    });

    renderAutoDialog(
      dispatchHandle({
        manualStepRuns: [
          manualStepRun({ status: "PAUSED", pausedReason: "FAILED", currentLine: FIRST_LINE }),
        ],
        jobs: [manualStepJob({ manualStepLine: FIRST_LINE, status: "FAILED", exitCode: 1 })],
      }),
    );

    expect(await screen.findByText("ユニット名が実際と違います。")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/manual-steps/fix",
      expect.objectContaining({ method: "POST" }),
    );
    // 送るのはジョブのidだけ（コマンドも出力もサーバーが読み直す）
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ jobId: "job-1" });
  });

  // 出力にはシークレットが混ざりうるので、送ってよいかは承認の時点で決める
  it("同意を外して承認した場合は、失敗しても出力を送らない", () => {
    renderAutoDialog(
      dispatchHandle({
        manualStepRuns: [
          manualStepRun({
            status: "PAUSED",
            pausedReason: "FAILED",
            diagnoseConsent: false,
            currentLine: FIRST_LINE,
          }),
        ],
        jobs: [manualStepJob({ manualStepLine: FIRST_LINE, status: "FAILED", exitCode: 1 })],
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "原因を調べる" })).toBeTruthy();
  });

  it("修正を適用すると、本文を書き換えてから続きをサーバーへ任せる（#1882）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        fix: {
          kind: "command",
          cause: "リポジトリの外で実行しています。",
          command: "git -C ~/apps/issue-deck pull --ff-only",
          advice: null,
        },
        currentCommand: "git pull --ff-only",
      }),
    });

    renderAutoDialog(
      dispatchHandle({
        manualStepRuns: [
          manualStepRun({ status: "PAUSED", pausedReason: "FAILED", currentLine: FIRST_LINE }),
        ],
        jobs: [
          manualStepJob({
            manualStepLine: FIRST_LINE,
            command: "git pull --ff-only",
            status: "FAILED",
            exitCode: 1,
          }),
        ],
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "修正を適用して実行" }));

    await vi.waitFor(() => expect(issueMutations.updateIssue).toHaveBeenCalled());
    const [patch] = issueMutations.updateIssue.mock.calls[0];
    expect(patch.body).toContain("git -C ~/apps/issue-deck pull --ff-only");
    // 書き換えたのはそのコマンドだけ（他の手順・確認はそのまま）
    expect(patch.body).toContain("systemctl --user restart issue-deck-poller.service");
    expect(patch.body).toContain("git rev-list --count HEAD..origin/develop");
    // **画面からは積み直さない。** 続きを流すのはサーバー
    await vi.waitFor(() =>
      expect(controlManualStepRun).toHaveBeenCalledWith(
        expect.objectContaining({ action: "resume" }),
      ),
    );
    expect(runManualStep).not.toHaveBeenCalled();
  });
});

/**
 * 進捗レール（#2194）。**押せる目次であること**と、**担い手（代行できる／あなたが実行）が
 * ドットと手順の見出しに出ること**を見る。代行できるかどうかの判定そのものは
 * `lib/dispatch/dispatch-job.ts`と`lib/manual-step-autorun.ts`のテストが持つ。
 */
describe("ManualStepGuideDialog の進捗レール", () => {
  beforeEach(() => {
    taskList.body = BODY;
    taskList.isToggling = false;
    taskList.toggleTask.mockReset();
    runManualStep.mockReset().mockResolvedValue({ ok: true });
    controlManualStepRun.mockReset().mockResolvedValue({ ok: true, run: manualStepRun() });
  });

  afterEach(() => {
    cleanup();
  });

  it("ドットを押すとその段へ直接移動する", () => {
    renderDialog([issue()]);

    // 「戻る」「次へ」を辿らずに手順2（コマンドの無い手順）へ飛べる
    fireEvent.click(screen.getByRole("button", { name: /手順 2 \/ 2/ }));
    expect(screen.getByRole("heading", { name: /手順 2 \/ 2/ })).toBeTruthy();

    // 最初の段へも一手で戻れる
    fireEvent.click(screen.getByRole("button", { name: "この作業の目的" }));
    expect(screen.getByRole("heading", { name: "この作業でできるようになること" })).toBeTruthy();
  });

  it("押しても本文のチェックは変わらない（記録は飛ばせない）", () => {
    renderDialog([issue()]);

    fireEvent.click(screen.getByRole("button", { name: "完了の確認" }));

    expect(taskList.toggleTask).not.toHaveBeenCalled();
  });

  it("ドットと手順の見出しに担い手を出す", () => {
    renderDialog([issue()]);

    // 手順1はサブPCで実行するコマンドが1つ書かれているので代行できる
    expect(screen.getByRole("button", { name: /手順 1 \/ 2: 代行できる/ })).toBeTruthy();
    // 手順2にはコマンドのブロックが無いので人が実行する
    expect(screen.getByRole("button", { name: /手順 2 \/ 2: あなたが実行/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(screen.getByRole("heading", { name: /手順 1 \/ 2.*代行できる/ })).toBeTruthy();
  });

  /**
   * **ホストの都合と「そもそも代行の対象外」を畳まない**（計画レビューG1の指摘1）。
   * 畳むと、pollerが止まっている間だけ全段が「あなたが実行」に化け、理由も読まずに
   * 手で実行しに行くことになる。
   */
  it("サブPCが居ないときは「いまは代行できない」で、対象外の手順とは区別する", () => {
    renderDialog([issue()], undefined, dispatchHandle({ hosts: [] }));

    // 手順1はサブPCで実行するコマンドがある＝対象。ホストが居ないだけなので理由も出す
    const step1 = screen.getByRole("button", { name: /手順 1 \/ 2: いまは代行できない/ });
    expect(step1.getAttribute("title")).toContain("申告がまだ届いていません");
    // 手順2はコマンドが無い＝そもそも対象外なので、ホストの状態によらず人が実行する
    expect(screen.getByRole("button", { name: /手順 2 \/ 2: あなたが実行/ })).toBeTruthy();
  });

  /**
   * `## やること`が`- [ ]`で書かれていない本文は、節全体が`line: null`の1手順になり
   * 実行計画に載らない（計画レビューG1の指摘3）。代行の対象そのものが無い。
   */
  it("実行計画に載らない手順（チェックリストでない`## やること`）は「あなたが実行」になる", () => {
    taskList.body = `## やること

設定画面でトークンを入れ替える。
`;
    renderDialog([issue({ body: taskList.body })]);

    expect(screen.getByRole("button", { name: /手順 1 \/ 1: あなたが実行/ })).toBeTruthy();
  });

  it("完了の確認は、1件でも人が実行するなら「あなたが実行」になる", () => {
    taskList.body = `## 前提条件

- 実行するデバイス: **サブPC**

## やること

- [ ] pollerを再起動する

## 完了の確認方法

\`\`\`bash
systemctl --user is-active issue-deck-poller.service
\`\`\`

\`\`\`bash
curl -s http://localhost:<ポート>/api/health
\`\`\`
`;
    renderDialog([issue({ body: taskList.body })]);

    // 1件目は代行できるが、2件目にプレースホルダがあるので重い方に合わせる
    expect(
      screen.getByRole("button", { name: /完了の確認（あなたが実行）/ }),
    ).toBeTruthy();
  });

  it("実行済みの手順は「実行済みを取り消す」でチェックを外せる", () => {
    taskList.body = BODY.replace("- [ ] チェックアウトを更新する", "- [x] チェックアウトを更新する");
    renderDialog([issue({ body: taskList.body })]);

    expect(screen.getByRole("button", { name: /手順 1 \/ 2: 実行済み/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    fireEvent.click(screen.getByRole("button", { name: "実行済みを取り消す" }));

    expect(taskList.toggleTask).toHaveBeenCalledWith(STEP_LINE, false);
    // 外すのはチェックだけ。実行し直しはサーバーに任せる（#1882の決まりのまま）
    expect(runManualStep).not.toHaveBeenCalled();
    expect(controlManualStepRun).not.toHaveBeenCalled();
  });

  it("未実行の手順には「実行済みを取り消す」を出さない", () => {
    renderDialog([issue()]);

    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    expect(screen.queryByRole("button", { name: "実行済みを取り消す" })).toBeNull();
  });
});

/**
 * 想定外だったときの出口（#2299）。
 *
 * 代行実行の失敗（#1869）と違い、**issue-deckには終了コードも出力も届かない**経路なので、
 * 人が書いたものが正しく運ばれること（送り先・Issueに残るもの・残らないもの）を中心に見る。
 */
describe("ManualStepGuideDialog のつまずきの報告", () => {
  const lines = BODY.split("\n");
  const FIRST_STEP_LINE = lines.findIndex((text) => text.includes("チェックアウトを更新する")) + 1;
  const fetchMock = vi.fn();

  beforeEach(() => {
    taskList.body = BODY;
    taskList.isToggling = false;
    taskList.toggleTask.mockReset();
    runManualStep.mockReset().mockResolvedValue({ ok: true });
    controlManualStepRun.mockReset().mockResolvedValue({ ok: true, run: manualStepRun() });
    issueMutations.updateIssue.mockReset().mockResolvedValue(issue());
    comments.list = [];
    createComment.mockReset().mockResolvedValue({ id: "c1" });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** 手順1の画面で「うまくいかない」を開き、起きたことを書くところまで */
  function openTrouble(detail: string) {
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    fireEvent.click(screen.getByRole("button", { name: "うまくいかない" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: detail } });
  }

  it("手順の画面から開ける（代行実行の成否によらず）", () => {
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));

    fireEvent.click(screen.getByRole("button", { name: "うまくいかない" }));

    expect(screen.getByText("何が起きましたか？")).toBeTruthy();
    expect(screen.getByRole("button", { name: "外部ツールの表示が違う" })).toBeTruthy();
  });

  it("起きたことを書くまでは記録も診断も押せない", () => {
    renderDialog([issue()]);
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    fireEvent.click(screen.getByRole("button", { name: "うまくいかない" }));

    expect(screen.getByRole("button", { name: "原因を調べる" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      screen.getByRole("button", { name: "Issueに記録して次へ" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("記録するとIssueコメントになり、チェックは付かないまま次へ進む", async () => {
    openTrouble("画面に「新規アイテム」がありません");
    fireEvent.click(screen.getByRole("button", { name: "外部ツールの表示が違う" }));

    fireEvent.click(screen.getByRole("button", { name: "Issueに記録して次へ" }));

    await vi.waitFor(() => expect(createComment).toHaveBeenCalled());
    const [input] = createComment.mock.calls[0];
    expect(input.number).toBe(1823);
    expect(input.body).toContain("- つまずいたところ: 手順 1 / 2");
    expect(input.body).toContain("- 分類: 外部ツールの表示が違う");
    expect(input.body).toContain("画面に「新規アイテム」がありません");
    expect(input.body).toContain("<!-- manual-step-trouble:1:display -->");
    // 実行できていないので、チェックは付けない
    expect(taskList.toggleTask).not.toHaveBeenCalled();
    // 次の手順へは進む
    await vi.waitFor(() => expect(screen.getAllByText("手順 2 / 2").length).toBeGreaterThan(0));
  });

  it("診断はどの手順についてかを送り、同意が無ければ貼った内容を送らない", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        fix: { kind: "manual", cause: "権限が足りません。", command: null, instruction: null, advice: null },
        currentCommand: null,
        currentInstruction: "チェックアウトを更新する",
      }),
    });

    openTrouble("権限エラーになりました");
    fireEvent.click(screen.getByRole("button", { name: "出力・画面の文言を貼る（任意）" }));
    const [, paste] = screen.getAllByRole("textbox");
    fireEvent.change(paste, { target: { value: "Permission denied" } });

    fireEvent.click(screen.getByRole("button", { name: "原因を調べる" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/manual-steps/fix");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      repositoryFullName: REPO,
      number: 1823,
      kind: "step",
      line: FIRST_STEP_LINE,
      report: { category: null, detail: "権限エラーになりました", pasted: "" },
    });
    expect(await screen.findByText("権限が足りません。")).toBeTruthy();
  });

  // #2310。原因だけ出して「手元で対処してください」で終わると、読んだ人が次に何を打てばよいか決まらない
  it("本文を直せないときは、この後にやることをコマンド付きで並べる", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        fix: {
          kind: "manual",
          cause: "ZaimGenreテーブルがありません。",
          command: null,
          instruction: null,
          advice: null,
          steps: [
            { text: "（サブPC）マイグレーションを流す", command: "pnpm prisma migrate deploy" },
            { text: "（ブラウザ）画面を開き直す", command: null },
          ],
        },
        currentCommand: null,
        currentInstruction: "チェックアウトを更新する",
      }),
    });

    openTrouble("テーブルが無いというエラーが出ました");
    fireEvent.click(screen.getByRole("button", { name: "原因を調べる" }));

    expect(await screen.findByText("この後にやること")).toBeTruthy();
    expect(screen.getByText("（サブPC）マイグレーションを流す")).toBeTruthy();
    expect(screen.getByText("pnpm prisma migrate deploy")).toBeTruthy();
    // コマンドが無い手順も出る（画面での操作）
    expect(screen.getByText("（ブラウザ）画面を開き直す")).toBeTruthy();
    // **実行はさせない。** issue-deckが実行するのは本文に書かれたコマンドだけ
    expect(screen.getByRole("button", { name: "コマンドをコピー" })).toBeTruthy();
  });

  it("やることを絞り込めなかったときは、貼り付けて調べ直すよう促す", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        fix: {
          kind: "manual",
          cause: "情報が足りず原因を特定できません。",
          command: null,
          instruction: null,
          advice: null,
          steps: [],
        },
        currentCommand: null,
        currentInstruction: "チェックアウトを更新する",
      }),
    });

    openTrouble("よく分からないエラーが出ました");
    fireEvent.click(screen.getByRole("button", { name: "原因を調べる" }));

    expect(
      await screen.findByText(/「出力・画面の文言を貼る」へ足して、もう一度「原因を調べる」/),
    ).toBeTruthy();
  });

  it("手順の説明文の直し案を適用すると、その1行だけが書き換わる", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        fix: {
          kind: "instruction",
          cause: "リポジトリの場所が変わっています。",
          command: null,
          instruction: "チェックアウトを最新のdevelopへ更新する",
          advice: null,
        },
        currentCommand: null,
        currentInstruction: "チェックアウトを更新する",
      }),
    });

    openTrouble("手順書の場所にリポジトリがありません");
    fireEvent.click(screen.getByRole("button", { name: "原因を調べる" }));

    fireEvent.click(await screen.findByRole("button", { name: "手順を直す" }));

    await vi.waitFor(() => expect(issueMutations.updateIssue).toHaveBeenCalled());
    const [patch] = issueMutations.updateIssue.mock.calls[0];
    expect(patch.body).toContain("- [ ] チェックアウトを最新のdevelopへ更新する");
    // 下のコマンドも、他の手順もそのまま
    expect(patch.body).toContain("git pull --ff-only");
    expect(patch.body).toContain("- [ ] pollerを再起動する");
    // 文言を直しただけなので、実行済みにはしない
    expect(taskList.toggleTask).not.toHaveBeenCalled();
  });

  it("過去に報告されたつまずきを最初の画面に出す", () => {
    comments.list = [
      {
        body: [
          "⚠️ **手作業でつまずきました。**",
          "",
          "- つまずいたところ: 手順 1 / 2「チェックアウトを更新する」",
          "- 分類: コマンドの出力が違う",
          "- 起きたこと: 別のブランチが出ていました",
          "",
          "<!-- manual-step-trouble:1:output -->",
        ].join("\n"),
      },
    ];

    renderDialog([issue()]);

    expect(screen.getByText("過去に報告されたつまずき（1件）")).toBeTruthy();
    expect(screen.getByText(/別のブランチが出ていました/)).toBeTruthy();
  });
});
