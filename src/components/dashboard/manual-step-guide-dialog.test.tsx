// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManualStepGuideDialog } from "@/components/dashboard/manual-step-guide-dialog";
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

function renderDialog(issues: Issue[], queueIds = issues.map((item) => item.id)) {
  const onIssueUpdated = vi.fn();
  render(
    <ManualStepGuideDialog
      queueIds={queueIds}
      issues={issues}
      open
      onOpenChange={vi.fn()}
      onIssueUpdated={onIssueUpdated}
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
