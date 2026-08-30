// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueOrderDialog } from "@/components/dashboard/issue-order-dialog";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { IssueOrderGuideHandle } from "@/hooks/use-issue-order-guide";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import type { IssueOrderView } from "@/lib/issue-order-view";
import type { Issue } from "@/types/issue";

/**
 * 見るのは**画面の出し分けと押したときの振る舞い**だけ。判定そのものは
 * `lib/claude/issue-order.test.ts`、並びの解決は`lib/issue-order-view.test.ts`が見ている。
 */

const enqueue = vi.fn();
const updateIssue = vi.fn();

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => ({ updateIssue, isSubmitting: false, error: null, setError: vi.fn() }),
}));

const REPO = "guchi-apps/issue-deck";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1801",
    number: 1801,
    title: "Issue一覧の絞り込みを共通化する",
    body: "",
    state: "open",
    repositoryFullName: REPO,
    labels: [{ name: "50.feature", color: "a2eeef", description: null }],
    createdAt: "2026-07-16T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  } as Issue;
}

function dispatchHandle(overrides: Partial<DispatchStateHandle> = {}): DispatchStateHandle {
  return {
    hosts: [
      { name: "subpc", online: true, repositories: [REPO] } as DispatchHostView,
    ],
    jobs: [],
    sessions: [],
    isLoaded: true,
    isSubmitting: false,
    error: null,
    enqueue,
    ...overrides,
  } as unknown as DispatchStateHandle;
}

const emptyView: IssueOrderView = { overview: "", top: null, rest: [], skip: [] };

function guideHandle(overrides: Partial<IssueOrderGuideHandle> = {}): IssueOrderGuideHandle {
  return {
    open: true,
    setOpen: vi.fn(),
    start: vi.fn(),
    redecide: vi.fn(),
    dismiss: vi.fn(),
    view: emptyView,
    isDeciding: false,
    error: null,
    notConfigured: false,
    candidateCount: 3,
    totalCount: 3,
    autoStart: false,
    setAutoStart: vi.fn(),
    ...overrides,
  };
}

function renderDialog(
  guide: IssueOrderGuideHandle,
  dispatch: DispatchStateHandle = dispatchHandle(),
) {
  const onSelectIssue = vi.fn();
  render(<IssueOrderDialog guide={guide} onSelectIssue={onSelectIssue} dispatch={dispatch} />);
  return { onSelectIssue };
}

const decidedView: IssueOrderView = {
  overview: "共通化を先に片付けます。",
  top: { issue: issue(), reason: "他の2件の前提になっているため" },
  rest: [
    {
      issue: issue({ id: "312", number: 312, title: "予定の並び替えが保存されない" }),
      reason: "短時間で終わるため",
    },
  ],
  skip: [
    {
      issue: issue({ id: "1509", number: 1509, title: "一覧の絞り込みを高速化する" }),
      reason: "#1836と重複しているように見えます",
    },
  ],
};

describe("IssueOrderDialog", () => {
  beforeEach(() => {
    enqueue.mockReset().mockResolvedValue(true);
    updateIssue.mockReset().mockResolvedValue(null);
  });
  afterEach(cleanup);

  it("判定中はその旨だけを出す", () => {
    renderDialog(guideHandle({ isDeciding: true }));

    expect(screen.getByText(/Claudeが3件を読んでいます/)).toBeTruthy();
    expect(screen.queryByText("このIssueを開く")).toBeNull();
  });

  it("トークン未設定の環境ではその理由を出す", () => {
    renderDialog(guideHandle({ notConfigured: true }));

    expect(screen.getByText(/選択したAIモデルの認証情報が設定されていない/)).toBeTruthy();
  });

  it("未着手が0件なら決める順番が無いことを出す", () => {
    renderDialog(guideHandle({ totalCount: 0, candidateCount: 0 }));

    expect(screen.getByText(/未着手のIssueがありません/)).toBeTruthy();
  });

  it("判定に失敗したらエラーを出す", () => {
    renderDialog(guideHandle({ error: "着手順の判定に失敗しました (502)" }));

    expect(screen.getByText("着手順の判定に失敗しました (502)")).toBeTruthy();
  });

  it("全体の方針・1位・2位以降・見送り候補を理由つきで出す", () => {
    renderDialog(guideHandle({ view: decidedView }));

    expect(screen.getByText("共通化を先に片付けます。")).toBeTruthy();
    expect(screen.getByText("Issue一覧の絞り込みを共通化する")).toBeTruthy();
    expect(screen.getByText("他の2件の前提になっているため")).toBeTruthy();
    expect(screen.getByText("予定の並び替えが保存されない")).toBeTruthy();
    expect(screen.getByText("実施しない方がよさそうなもの")).toBeTruthy();
    expect(screen.getByText("#1836と重複しているように見えます")).toBeTruthy();
  });

  it("1位を開くとダイアログを閉じてそのIssueを選ぶ", () => {
    const guide = guideHandle({ view: decidedView });
    const { onSelectIssue } = renderDialog(guide);

    fireEvent.click(screen.getByText("このIssueを開く"));

    expect(guide.setOpen).toHaveBeenCalledWith(false);
    expect(onSelectIssue).toHaveBeenCalledWith(decidedView.top!.issue);
  });

  it("見送ると、そのIssueのキーを親へ渡す", () => {
    const guide = guideHandle({ view: decidedView });
    renderDialog(guide);

    fireEvent.click(screen.getByText("見送って次の候補へ"));

    expect(guide.dismiss).toHaveBeenCalledWith("guchi-apps/issue-deck#1801");
  });

  // **見送り候補からクローズはさせない。** 判定は推測でしかなく、押せるのは開くことだけ
  it("見送り候補を押すとそのIssueを開く（クローズはしない）", () => {
    const guide = guideHandle({ view: decidedView });
    const { onSelectIssue } = renderDialog(guide);

    fireEvent.click(screen.getByText("一覧の絞り込みを高速化する"));

    expect(onSelectIssue).toHaveBeenCalledWith(decidedView.skip[0].issue);
    expect(updateIssue).not.toHaveBeenCalled();
  });

  describe("自動開始", () => {
    it("有効なら1位をサブPCへ積み、11.localを付ける", async () => {
      renderDialog(guideHandle({ view: decidedView, autoStart: true }));

      await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      expect(enqueue).toHaveBeenCalledWith({
        repositoryFullName: REPO,
        issueNumber: 1801,
        hostName: "subpc",
      });
      await waitFor(() =>
        expect(updateIssue).toHaveBeenCalledWith({
          repositoryFullName: REPO,
          number: 1801,
          labels: ["50.feature", "11.local"],
        }),
      );
      expect(await screen.findByText(/へ積みました/)).toBeTruthy();
    });

    it("無効なら積まない", async () => {
      renderDialog(guideHandle({ view: decidedView, autoStart: false }));

      await waitFor(() => expect(screen.getByText("このIssueを開く")).toBeTruthy());
      expect(enqueue).not.toHaveBeenCalled();
    });

    // 取得前の`hosts`は`[]`で「1台も無い」と区別が付かない（#1666・#1810）
    it("ディスパッチの状態を取得できるまで積まない", async () => {
      renderDialog(
        guideHandle({ view: decidedView, autoStart: true }),
        dispatchHandle({ isLoaded: false, hosts: [] }),
      );

      await waitFor(() => expect(screen.getByText("このIssueを開く")).toBeTruthy());
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("積めない状態なら理由を出し、ラベルは付けない", async () => {
      renderDialog(
        guideHandle({ view: decidedView, autoStart: true }),
        dispatchHandle({ hosts: [] }),
      );

      expect(await screen.findByText(/積める起動先がありません/)).toBeTruthy();
      expect(enqueue).not.toHaveBeenCalled();
      expect(updateIssue).not.toHaveBeenCalled();
    });
  });
});
