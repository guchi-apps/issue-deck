// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlanApprovalPanel } from "@/components/dashboard/plan-approval-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  PLAN_ARTIFACT_REQUEST_TEXT,
  PLAN_REVIEW_REFLECT_REQUEST_TEXT,
  type SessionPlanRequestView,
} from "@/lib/dispatch/session-plan-request";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { parsePlanReview, type PendingPlanReview } from "@/lib/github/plan-review";

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
    codexThreadKnown: null,
    ...overrides,
  } as DispatchSessionView;
}

function pendingReview(body: string): PendingPlanReview {
  return { commentId: "c-1", review: parsePlanReview(body), createdAtLabel: "4分前", round: 2, kind: "initial" };
}

function planReviewJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "plan-review-1",
    repositoryFullName: REPO,
    issueNumber: 2061,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    agent: "claude",
    claudeModel: null,
    kind: "PLAN_REVIEW",
    status: "QUEUED",
    message: null,
    instruction: null,
    recovery: false,
    command: null,
    placeholderValues: null,
    resolvedCommand: null,
    manualStepLine: null,
    manualStepRunTarget: "subpc",
    targetJobId: null,
    previewAction: null,
    exitCode: null,
    commandOutput: null,
    codexPairingCode: null,
    codexPairingExpiresAt: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: "2026-08-17T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
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

  // #3565。計画レビュー（G1）が作成中かどうかが承認パネルから分からなかったのを直す
  it("計画レビューのジョブが動いている間は「計画レビューを作成中」を出す", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReviewJob={planReviewJob({ status: "RUNNING" })}
      />,
    );
    expect(screen.getByText("計画レビューを作成中")).toBeTruthy();
  });

  it("作成中はオレンジの承認枠（見出し・承認ボタン）を出さない（#3726）", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReviewJob={planReviewJob({ status: "RUNNING" })}
      />,
    );
    expect(screen.queryByText("計画の承認を待っています")).toBeNull();
    expect(screen.queryByRole("button", { name: /承認して実装へ進む/ })).toBeNull();
  });

  // #3772。サブPCが取りに来ない間も「作成中」と出し続け、5時間超その表示のままになっていた
  it("起動待ち（QUEUED）の間は「作成中」ではなく起動待ちを出す", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReviewJob={planReviewJob({ status: "QUEUED", createdAt: new Date().toISOString() })}
      />,
    );
    expect(screen.getByText("計画レビューの起動を待っています")).toBeTruthy();
    expect(screen.queryByText("計画レビューを作成中")).toBeNull();
    expect(screen.queryByRole("button", { name: /承認して実装へ進む/ })).toBeNull();
  });

  it("起動待ちが10分を超えたら、注記を添えて承認枠を出す", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReviewJob={planReviewJob({
          status: "QUEUED",
          createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
        })}
      />,
    );
    expect(screen.getByText(/まだ起動していません/)).toBeTruthy();
    expect(screen.getByText("計画の承認を待っています")).toBeTruthy();
  });

  it("計画レビューのジョブが無ければ出さない", () => {
    render(
      <PlanApprovalPanel request={request()} session={session()} dispatch={dispatchHandle()} />,
    );
    expect(screen.queryByText("計画レビューを作成中")).toBeNull();
  });

  it("計画レビューのジョブが終わっていれば（失敗・見送り等）出さない", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReviewJob={planReviewJob({ status: "FAILED" })}
      />,
    );
    expect(screen.queryByText("計画レビューを作成中")).toBeNull();
  });

  it("指摘コメントが届いても、ジョブが作成中のあいだ（採否判定中）は作成中を出し続ける（#4304）", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReviewJob={planReviewJob({ status: "RUNNING" })}
        planReview={pendingReview("自由に書かれた講評\n\n<!-- supervisor:plan-review -->")}
      />,
    );
    expect(screen.getByText("計画レビューを作成中")).toBeTruthy();
    expect(screen.queryByText("計画の承認を待っています")).toBeNull();
  });

  it("指摘コメントが届き、採否が決まったら指摘のカードに切り替わる", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReviewJob={planReviewJob({
          status: "SUCCEEDED",
          finishedAt: new Date().toISOString(),
          planReviewDecidedAt: new Date().toISOString(),
        })}
        planReview={pendingReview("自由に書かれた講評\n\n<!-- supervisor:plan-review -->")}
      />,
    );
    expect(screen.queryByText("計画レビューを作成中")).toBeNull();
    // 見出しは何回目のレビューかを出す。関門の番号「G1」は出さない（#3757）
    expect(screen.getByRole("heading", { name: "計画レビュー（2回目）" })).toBeTruthy();
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

  it("実装に使うモデル欄を表示せずに承認を送る", async () => {
    const decidePlan = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PlanApprovalPanel
        request={request()}
        session={session({ codexThreadKnown: true })}
        dispatch={dispatchHandle(decidePlan)}
      />,
    );

    expect(screen.queryByText("実装に使うモデル")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /承認して実装へ進む/ }));

    await waitFor(() => {
      expect(decidePlan).toHaveBeenCalledWith({
        id: "req-1",
        decision: "approve",
        text: undefined,
      });
    });
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

  it("アーティファクトが無いときだけ作成依頼を出し、固定文を修正として送る（#3493）", async () => {
    const decidePlan = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = render(
      <PlanApprovalPanel request={request()} session={session()} dispatch={dispatchHandle(decidePlan)} />,
    );
    expect(screen.queryByRole("button", { name: /アーティファクトの作成を依頼/ })).toBeNull();

    rerender(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(decidePlan)}
        artifactsMissing
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /アーティファクトの作成を依頼/ }));
    await waitFor(() =>
      expect(decidePlan).toHaveBeenCalledWith({
        id: "req-1",
        decision: "revise",
        text: PLAN_ARTIFACT_REQUEST_TEXT,
      }),
    );
  });

  it("指摘に分けられない計画レビューは、従来の一括反映ボタンで固定文を送る（#3521・#3554）", async () => {
    const decidePlan = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = render(
      <PlanApprovalPanel request={request()} session={session()} dispatch={dispatchHandle(decidePlan)} />,
    );
    expect(screen.queryByRole("button", { name: /レビューを反映して計画を出し直す/ })).toBeNull();

    rerender(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(decidePlan)}
        planReview={pendingReview("自由に書かれた講評\n\n<!-- supervisor:plan-review -->")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /レビューを反映して計画を出し直す/ }));
    await waitFor(() =>
      expect(decidePlan).toHaveBeenCalledWith({
        id: "req-1",
        decision: "revise",
        text: PLAN_REVIEW_REFLECT_REQUEST_TEXT,
      }),
    );
  });

  it("追加で修正したいことが未送信の間は承認を止め、空にすれば承認できる（#3852）", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(vi.fn().mockResolvedValue({ ok: true }))}
        planReview={pendingReview(
          [
            "**1. テストが型で落ちる**",
            "- **指摘**: 5本のテストが落ちる",
            "- **根拠**: `a.ts:1`",
            "- **提案**: 変更対象に加える",
            "",
            "推奨: 修正のうえ承認",
            "<!-- supervisor:plan-review -->",
          ].join("\n"),
        )}
      />,
    );
    const approve = () => screen.getByRole("button", { name: /承認して実装へ進む/ }) as HTMLButtonElement;
    expect(approve().disabled).toBe(false);

    const box = screen.getByLabelText("追加で修正したいこと（任意）");
    fireEvent.change(box, { target: { value: "ここも直して" } });
    expect(approve().disabled).toBe(true);
    expect(screen.getByText(/未送信です/)).toBeTruthy();

    fireEvent.change(box, { target: { value: "" } });
    expect(approve().disabled).toBe(false);
  });

  it("計画レビューの指摘ごとに反映・見送りを選び、見送る理由を添えて送る（#3554）", async () => {
    const decidePlan = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(decidePlan)}
        planReview={pendingReview(
          [
            "**1. テストが型で落ちる**",
            "- **指摘**: 5本のテストが落ちる",
            "- **根拠**: `a.ts:1`",
            "- **提案**: 変更対象に加える",
            "",
            "**2. docsに言及が残る**",
            "- **指摘**: 記述が残る",
            "",
            "推奨: 修正のうえ承認（1を直せばよい）",
            "<!-- supervisor:plan-review -->",
          ].join("\n"),
        )}
      />,
    );

    // 推奨と指摘の中身がパネルの中で読める。根拠は畳んである
    expect(screen.getByText("推奨: 修正のうえ承認")).toBeTruthy();
    // 推奨の理由は既定で隠れていて、開閉ボタンで開く（#3754）
    expect(screen.queryByText("1を直せばよい")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /推奨の理由とレビュー要約/ }));
    expect(screen.getByText("1を直せばよい")).toBeTruthy();
    expect(screen.getByText("5本のテストが落ちる")).toBeTruthy();
    expect(screen.queryByText("a.ts:1")).toBeNull();
    // 反映させる指摘が残っている間は、承認より出し直しを主ボタンにする
    expect(screen.getByRole("button", { name: /承認して実装へ進む/ }).dataset.variant).toBe("outline");

    fireEvent.click(within(screen.getByRole("group", { name: "指摘2の扱い" })).getByRole("button", { name: "見送る" }));
    fireEvent.change(screen.getByLabelText("見送る理由（任意）"), { target: { value: "別Issueで直す" } });
    expect(screen.getByText(/反映 1件・見送り 1件/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /選んだ指摘で計画を出し直す/ }));
    await waitFor(() => expect(decidePlan).toHaveBeenCalledTimes(1));
    const text = decidePlan.mock.calls[0][0].text as string;
    expect(text).toContain("反映する:\n- 1. テストが型で落ちる");
    expect(text).toContain("見送る:\n- 2. docsに言及が残る（理由: 別Issueで直す）");
  });

  it("判断は全件選ぶまで送れず、選んだ選択肢が修正に載る（#3660）", async () => {
    const decidePlan = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle(decidePlan)}
        planReview={pendingReview(
          [
            "**判断1. 書式をどうするか**",
            "- **論点**: 好みの問題",
            "- **選択肢**:",
            "  - A. 専用の見出し",
            "  - B. 指摘の中に足す",
            "- **推奨**: A",
            "",
            "**判断2. 範囲**",
            "- **選択肢**:",
            "  - A. 今回だけ",
            "  - B. 両方",
            "<!-- supervisor:plan-review -->",
          ].join("\n"),
        )}
      />,
    );
    const submit = () => screen.getByRole("button", { name: /選んだ内容で計画を出し直す/ }) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    expect(screen.getByText(/判断があと2件残っています/)).toBeTruthy();

    fireEvent.click(within(screen.getByRole("group", { name: "判断1の選択肢" })).getByRole("button", { name: /B\. 指摘の中に足す/ }));
    expect(submit().disabled).toBe(true);
    fireEvent.click(within(screen.getByRole("listitem", { name: "判断2" })).getByRole("button", { name: "セッションに任せる" }));
    expect(submit().disabled).toBe(false);

    fireEvent.click(submit());
    await waitFor(() => expect(decidePlan).toHaveBeenCalledTimes(1));
    const text = decidePlan.mock.calls[0][0].text as string;
    expect(text).toContain("判断:\n- 判断1. 書式をどうするか → B. 指摘の中に足す\n- 判断2. 範囲 → セッションに任せる");
  });

  it("すべて見送ると出し直しは押せず、承認を促す（#3554）", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReview={pendingReview("**1. 見出し**\n- **指摘**: 問題\n<!-- supervisor:plan-review -->")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "見送る" }));
    expect(
      (screen.getByRole("button", { name: /選んだ指摘で計画を出し直す/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("すべて見送る場合は、この計画のまま承認してください。")).toBeTruthy();
  });

  it("指摘なしのレビューは出し直しのボタンを出さず、承認を主ボタンに戻す（#3554）", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReview={pendingReview("指摘なし。\n\n推奨: このまま承認してよい\n<!-- supervisor:plan-review -->")}
      />,
    );
    expect(screen.getByText("指摘なし")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /出し直す/ })).toBeNull();
    expect(screen.getByRole("button", { name: /承認して実装へ進む/ }).dataset.variant).toBe("default");
  });

  it("推奨が「このまま承認」なら、指摘があっても承認を主ボタンにし、出し直しを通常ボタンにする（#3670）", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReview={pendingReview(
          "**1. 軽微な指摘**\n- **指摘**: 些細\n\n推奨: このまま承認してよい\n<!-- supervisor:plan-review -->",
        )}
      />,
    );
    expect(screen.getByRole("button", { name: /承認して実装へ進む/ }).dataset.variant).toBe("default");
    expect(screen.getByRole("button", { name: /選んだ指摘で計画を出し直す/ }).dataset.variant).toBe(
      "outline",
    );
  });

  it("推奨が「修正のうえ承認」なら、従来どおり出し直しが主ボタン（#3670）", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReview={pendingReview(
          "**1. 指摘**\n- **指摘**: 問題\n\n推奨: 修正のうえ承認\n<!-- supervisor:plan-review -->",
        )}
      />,
    );
    expect(screen.getByRole("button", { name: /承認して実装へ進む/ }).dataset.variant).toBe("outline");
    expect(screen.getByRole("button", { name: /選んだ指摘で計画を出し直す/ }).dataset.variant).toBe(
      "default",
    );
  });

  it("推奨が承認でも、人が選ぶ判断が残っていれば承認を強調しない（#3670）", () => {
    render(
      <PlanApprovalPanel
        request={request()}
        session={session()}
        dispatch={dispatchHandle()}
        planReview={pendingReview(
          [
            "**判断1. 書式をどうするか**",
            "- **選択肢**:",
            "  - A. 専用の見出し",
            "  - B. 指摘の中に足す",
            "",
            "推奨: このまま承認してよい",
            "<!-- supervisor:plan-review -->",
          ].join("\n"),
        )}
      />,
    );
    expect(screen.getByRole("button", { name: /承認して実装へ進む/ }).dataset.variant).toBe("outline");
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

  /** #2425。画像を添付して送ると、本文の後ろに画像記法が付いた1本の文として渡る */
  it("画像を添付して送ると、本文の後ろに画像記法が付く", async () => {
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

    // 添付はサムネイルのまま残り、入力欄には本文だけが見える
    expect(container.querySelectorAll('[data-slot="mention-attachments"] img').length).toBe(1);
    expect(textarea.value).toBe("ここを直して。");

    // アップロード中は送れない（まだURLの入っていない本文が渡ってしまうため）
    await waitFor(() => expect(latestReviseButton().disabled).toBe(false));
    fireEvent.click(latestReviseButton());
    await waitFor(() =>
      expect(decidePlan).toHaveBeenCalledWith({
        id: "req-1",
        decision: "revise",
        text: "ここを直して。\n\n![a.png](/api/issues/images/a.png)",
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
   * #3218。Codexでは`submit-plan.sh`が判断を取りに来ないので、フックからの
   * `report_delivery`は永遠に届かない。issue-deckが`INSTRUCTION`ジョブを積めたかを
   * 代わりに書き、パネルはそれを出す（既定の「取得・処理完了報告を待っています」のままだと、
   * 待っている相手が居ないのに待ち続けているように見える）。
   */
  it("Codexへ継続指示を積めたかを出す", () => {
    render(
      <PlanApprovalPanel
        request={request({
          status: "APPROVED",
          decidedAt: new Date().toISOString(),
          deliveryStatus: "CODEX_QUEUED",
        })}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText(/継続指示を積みました/)).toBeTruthy();
  });

  it("Codexへ積めなかったときは理由と次の手を出す", () => {
    render(
      <PlanApprovalPanel
        request={request({
          status: "APPROVED",
          decidedAt: new Date().toISOString(),
          deliveryStatus: "CODEX_QUEUE_FAILED",
          deliverySummary: "Codexのセッションが動いていません。",
        })}
        session={session()}
        dispatch={dispatchHandle()}
      />,
    );

    expect(screen.getByText(/Codexのセッションが動いていません。/)).toBeTruthy();
    expect(screen.getByText(/端末から続きを指示してください/)).toBeTruthy();
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
