// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlanApprovalPanel } from "@/components/dashboard/plan-approval-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { SessionPlanRequestView } from "@/lib/dispatch/session-plan-request";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const REPO = "guchi-apps/issue-deck";

function request(overrides: Partial<SessionPlanRequestView> = {}): SessionPlanRequestView {
  return {
    id: "req-1",
    repositoryFullName: REPO,
    issueNumber: 2061,
    hostName: "subpc",
    plan: "## 要約\n\n**計画の承認パネルをIssue詳細に出す**",
    status: "WAITING",
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 27 * 60 * 1000).toISOString(),
    decidedAt: null,
    delivered: false,
    ...overrides,
  };
}

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    id: "session-1",
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-2061",
    repositoryFullName: REPO,
    issueNumber: 2061,
    state: "ALIVE",
    activity: "WAITING_INPUT",
    ...overrides,
  } as DispatchSessionView;
}

function dispatchHandle(decidePlan = vi.fn().mockResolvedValue({ ok: true })) {
  return { decidePlan, isSubmitting: false } as unknown as DispatchStateHandle;
}

/** 修正入力モードでは「修正を送る」が2つ並ぶ（切り替えたときのボタンと、送信ボタン） */
function latestReviseButton() {
  return screen.getAllByRole("button", { name: /修正を送る/ }).at(-1) as HTMLButtonElement;
}

describe("PlanApprovalPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("計画の中身と、承認・修正・端末で答えるの3つを出す", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText("計画の承認を待っています")).toBeTruthy();
    expect(screen.getByText("計画の承認パネルをIssue詳細に出す")).toBeTruthy();
    expect(screen.getByRole("button", { name: /承認して実装へ進む/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /修正を送る/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /端末・Remote Controlで答える/ })).toBeTruthy();
  });

  it("承認を押すと`approve`を送り、押した結果をその場に出す", async () => {
    const decidePlan = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(decidePlan)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /承認して実装へ進む/ }));

    await waitFor(() => {
      expect(decidePlan).toHaveBeenCalledWith({
        id: "req-1",
        decision: "approve",
        text: undefined,
      });
    });
    await waitFor(() => expect(screen.getByText("承認を送りました。")).toBeTruthy());
  });

  /**
   * #2341。ラベルを外すのはサーバー側だが、一覧のポーリングは10秒間隔なので、押した直後の
   * 画面にはラベルと確認待ちのカードが残ったままになる。手元のIssueにも先に反映させる。
   */
  it("承認・修正を送ると、確認待ちが解けたことを親へ伝える", async () => {
    const onCheckUserResolved = vi.fn();
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        onCheckUserResolved={onCheckUserResolved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /承認して実装へ進む/ }));
    await waitFor(() => expect(onCheckUserResolved).toHaveBeenCalledTimes(1));
  });

  // 端末で答えると言っただけで、人はまだ答えていない
  it("端末・Remote Controlで答える場合は伝えない", async () => {
    const onCheckUserResolved = vi.fn();
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        onCheckUserResolved={onCheckUserResolved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /端末・Remote Controlで答える/ }));
    await waitFor(() =>
      expect(screen.getByText("端末に承認プロンプトを出しました。")).toBeTruthy(),
    );
    expect(onCheckUserResolved).not.toHaveBeenCalled();
  });

  /** `deny`の理由がそのまま次の指示になるので、本文が空のまま送れてはいけない */
  it("修正は本文を書くまで送れない", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /修正を送る/ }));
    const send = screen.getByRole("button", { name: /修正を送る/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("修正してほしいこと"), {
      target: { value: "待ち時間を短くしてください。" },
    });
    expect((screen.getByRole("button", { name: /修正を送る/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  /**
   * #2425。**画面の直しを頼むのに、文章だけでは伝わらない。** 素の`Textarea`だった頃は
   * 「ここの余白を詰めて」を書き起こすしかなく、スクリーンショットを渡すには一度Issueへ
   * コメントしてからRemote Controlで指す必要があった。
   */
  it("修正の入力欄から画像を添付でき、画像記法込みでClaudeへ渡る", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ url: "/api/issues/images/shot.png" }),
        }),
      ),
    );
    const decidePlan = vi.fn().mockResolvedValue({ ok: true });
    const { container } = render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(decidePlan)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /修正を送る/ }));
    fireEvent.change(screen.getByLabelText("修正してほしいこと"), {
      target: { value: "この見た目にしてください。" },
    });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", {
      value: [new File(["dummy"], "shot.png", { type: "image/png" })],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() =>
      expect(container.querySelectorAll('[data-slot="mention-attachments"] img').length).toBe(1),
    );

    // 入力欄にはURLを出さず、送る値にだけ画像記法が乗る
    expect((screen.getByLabelText("修正してほしいこと") as HTMLTextAreaElement).value).toBe(
      "この見た目にしてください。",
    );

    // アップロード中は送れない（まだURLの入っていない本文が渡ってしまうため）
    await waitFor(() => expect(latestReviseButton().disabled).toBe(false));
    fireEvent.click(latestReviseButton());
    await waitFor(() =>
      expect(decidePlan).toHaveBeenCalledWith({
        id: "req-1",
        decision: "revise",
        text: "この見た目にしてください。\n\n![shot.png](/api/issues/images/shot.png)",
      }),
    );
  });

  /** 画像だけでも送れる。「この見た目にして」は1枚渡すのがいちばん速い（#2425） */
  it("文章が空でも、画像を添付していれば送れる", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /修正を送る/ }));
    fireEvent.change(screen.getByLabelText("修正してほしいこと"), {
      target: { value: "" },
    });
    expect(latestReviseButton().disabled).toBe(true);
  });

  /**
   * #2425。定型文を末尾へ足すと画像記法の下に文が来て、`splitAttachments`が添付として
   * 読めなくなる（サムネイルが消えて本文にURLが出る）。差し込む先は本文。
   */
  it("定型文は添付の前（本文の末尾）へ差し込む", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ url: "/api/issues/images/a.png" }),
        }),
      ),
    );
    const decidePlan = vi.fn().mockResolvedValue({ ok: true });
    const { container } = render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(decidePlan)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /修正を送る/ }));
    const textarea = screen.getByLabelText("修正してほしいこと") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "ここを直して。" } });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", {
      value: [new File(["dummy"], "a.png", { type: "image/png" })],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() =>
      expect(container.querySelectorAll('[data-slot="mention-attachments"] img').length).toBe(1),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "懸念点をもう少し具体的に書いてください。" }),
    );

    // 添付はサムネイルのまま残り、定型文は本文の末尾へ入る
    expect(container.querySelectorAll('[data-slot="mention-attachments"] img').length).toBe(1);
    expect(textarea.value).toBe("ここを直して。\n懸念点をもう少し具体的に書いてください。");

    // アップロード中は送れない（まだURLの入っていない本文が渡ってしまうため）
    await waitFor(() => expect(latestReviseButton().disabled).toBe(false));
    fireEvent.click(latestReviseButton());
    await waitFor(() =>
      expect(decidePlan).toHaveBeenCalledWith({
        id: "req-1",
        decision: "revise",
        text: "ここを直して。\n懸念点をもう少し具体的に書いてください。\n\n![a.png](/api/issues/images/a.png)",
      }),
    );
  });

  it("押した結果は、押していなくてもサーバー側の状態から出す（他の端末で押された場合）", () => {
    render(
      <PlanApprovalPanel
        request={request({ status: "REVISION_REQUESTED", decidedAt: new Date().toISOString() })}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText("修正を送りました。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /承認して実装へ進む/ })).toBeNull();
  });

  /**
   * #2158。**押していない計画に「承認を送りました」が出ていた。**
   *
   * Issue詳細はIssueを切り替えてもマウントされたままなので、押した結果を
   * 「承認した」とだけ覚えていると、別のIssueの計画・出し直された計画に差し替わっても
   * その表示が残る（画面の上には「計画の承認が必要です」が出たまま、下には
   * 「承認を送りました」が並ぶ）。
   */
  it("別の計画に差し替わったら、押した結果を持ち越さない", async () => {
    const { rerender } = render(
      <PlanApprovalPanel request={request()} session={session()} dispatch={dispatchHandle()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /承認して実装へ進む/ }));
    await waitFor(() => expect(screen.getByText("承認を送りました。")).toBeTruthy());

    rerender(
      <PlanApprovalPanel
        request={request({ id: "req-2" })}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.queryByText("承認を送りました。")).toBeNull();
    expect(screen.getByText("計画の承認を待っています")).toBeTruthy();
    expect(screen.getByRole("button", { name: /承認して実装へ進む/ })).toBeTruthy();
  });

  it("待ち時間が切れたら、端末で答えるよう案内する", () => {
    render(
      <PlanApprovalPanel
        request={request({ status: "EXPIRED" })}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText("端末に承認プロンプトを出しました。")).toBeTruthy();
  });

  /** 終了したセッションへ押しても届かない。**ボタンは消さずに理由を出す** */
  it("セッションが終了していたら、押せない理由を出す", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session({ state: "EXITED" })}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText(/このセッションは終了しています/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /承認して実装へ進む/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
