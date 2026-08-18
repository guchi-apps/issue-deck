// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualStepGuideDialog } from "@/components/dashboard/manual-step-guide-dialog";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
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
  overrides: { hosts?: DispatchHostView[]; jobs?: DispatchJobView[] } = {},
): DispatchStateHandle {
  return {
    hosts: overrides.hosts ?? [subpcHost()],
    jobs: overrides.jobs ?? [],
    sessions: [],
    isSubmitting: false,
    runManualStep,
    cancel: vi.fn(),
  } as unknown as DispatchStateHandle;
}

function subpcHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    online: true,
    manualStepCapable: true,
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
    issueMutations.updateIssue.mockReset().mockResolvedValue(issue({ body: AUTO_BODY }));
    fetchMock.mockReset();
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

  it("承認すると1件目を実行し、成功したら次の手順へ自動で進む", async () => {
    const view = renderAutoDialog(dispatchHandle());

    fireEvent.click(screen.getByRole("button", { name: "承認して3件を自動実行" }));

    expect(runManualStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepLine: FIRST_LINE, command: "git pull --ff-only" }),
    );

    view.rerender(
      dispatchHandle({ jobs: [manualStepJob({ manualStepLine: FIRST_LINE, exitCode: 0 })] }),
    );

    // 成功した手順にはチェックが付き、次の手順が積まれる
    expect(taskList.toggleTask).toHaveBeenCalledWith(FIRST_LINE, true);
    expect(runManualStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepLine: SECOND_LINE,
        command: "systemctl --user restart issue-deck-poller.service",
      }),
    );
  });

  it("最後は完了の確認のコマンドまで流し、クローズはしない", async () => {
    const view = renderAutoDialog(dispatchHandle());
    fireEvent.click(screen.getByRole("button", { name: "承認して3件を自動実行" }));

    view.rerender(
      dispatchHandle({ jobs: [manualStepJob({ manualStepLine: FIRST_LINE, exitCode: 0 })] }),
    );
    view.rerender(
      dispatchHandle({
        jobs: [
          manualStepJob({ id: "job-2", manualStepLine: SECOND_LINE, exitCode: 0 }),
          manualStepJob({ manualStepLine: FIRST_LINE, exitCode: 0 }),
        ],
      }),
    );

    expect(runManualStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepLine: VERIFICATION_LINE,
        command: "git rev-list --count HEAD..origin/develop",
      }),
    );
    expect(issueMutations.updateIssue).not.toHaveBeenCalled();
  });

  it("失敗したらそこで止まり、次の手順を積まない", () => {
    const view = renderAutoDialog(dispatchHandle());
    fireEvent.click(screen.getByRole("button", { name: "承認して3件を自動実行" }));
    expect(runManualStep).toHaveBeenCalledTimes(1);

    view.rerender(
      dispatchHandle({
        jobs: [
          manualStepJob({
            manualStepLine: FIRST_LINE,
            status: "FAILED",
            exitCode: 1,
            commandOutput: "error: Your local changes would be overwritten",
          }),
        ],
      }),
    );

    expect(runManualStep).toHaveBeenCalledTimes(1);
    expect(taskList.toggleTask).not.toHaveBeenCalled();
    expect(screen.getByText("失敗したため止まっています")).toBeTruthy();
  });

  // 終わったジョブは24時間画面に残る。**前回の失敗を理由に、これから積む1件を止めない**
  it("前回の実行で失敗した手順でも、承認したら実行し直す", () => {
    renderAutoDialog(
      dispatchHandle({
        jobs: [
          manualStepJob({
            manualStepLine: FIRST_LINE,
            status: "FAILED",
            exitCode: 1,
            createdAt: "2026-08-16T00:00:00Z",
          }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "承認して3件を自動実行" }));

    expect(runManualStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepLine: FIRST_LINE, command: "git pull --ff-only" }),
    );
    expect(screen.queryByText("失敗したため止まっています")).toBeNull();
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

    const view = renderAutoDialog(dispatchHandle());
    fireEvent.click(screen.getByRole("button", { name: "承認して3件を自動実行" }));
    view.rerender(
      dispatchHandle({
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
    const view = renderAutoDialog(dispatchHandle());

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "承認して3件を自動実行" }));
    view.rerender(
      dispatchHandle({
        jobs: [manualStepJob({ manualStepLine: FIRST_LINE, status: "FAILED", exitCode: 1 })],
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "原因を調べる" })).toBeTruthy();
  });

  it("修正を適用すると、本文を書き換えてから実行する", async () => {
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

    const view = renderAutoDialog(dispatchHandle());
    fireEvent.click(screen.getByRole("button", { name: "承認して3件を自動実行" }));
    view.rerender(
      dispatchHandle({
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
    await vi.waitFor(() =>
      expect(runManualStep).toHaveBeenCalledWith(
        expect.objectContaining({
          stepLine: FIRST_LINE,
          command: "git -C ~/apps/issue-deck pull --ff-only",
        }),
      ),
    );
  });
});
