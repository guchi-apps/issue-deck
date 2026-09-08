// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MergeApprovalActions } from "@/components/dashboard/merge-approval-actions";
import { PR_FIX_SESSION_INSTRUCTION } from "@/lib/dispatch/pr-fix-request";
import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";

const review: PullRequestReviewCommentContent = {
  verdictKind: "changes-requested",
  verdictLabel: "要修正",
  body: "- `a.ts:1` を直す",
  createdAt: new Date().toISOString(),
  htmlUrl: null,
  reviewedSha: "0123456",
  isStale: false,
};

function renderActions(props: Partial<React.ComponentProps<typeof MergeApprovalActions>> = {}) {
  return render(
    <MergeApprovalActions
      repositoryFullName="m-guchi/issue-deck"
      issueSuggestions={[]}
      onRequestPrFix={async () => {}}
      {...props}
    />,
  );
}

/**
 * #2914で`comment-thread.tsx`の承認カードから移した部分。テストもそのまま持ってきている
 * （元は「CommentThread PRマージ待ちの修正を依頼するテキスト入力」）。
 */
describe("MergeApprovalActions 修正依頼", () => {
  afterEach(() => {
    cleanup();
  });

  it("入力欄が常設表示される", () => {
    renderActions();
    expect(screen.getByPlaceholderText("修正依頼を入力（必須）")).not.toBeNull();
  });

  it("空文字では修正を依頼するが送信されずエラー文言が出る", () => {
    const onRequestPrFix = vi.fn();
    renderActions({ onRequestPrFix });
    fireEvent.click(screen.getByRole("button", { name: "修正を依頼する" }));
    expect(screen.getByText("修正内容を入力してください")).not.toBeNull();
    expect(onRequestPrFix).not.toHaveBeenCalled();
  });

  it("入力ありでonRequestPrFix(text)が呼ばれる", () => {
    const onRequestPrFix = vi.fn();
    renderActions({ onRequestPrFix });
    const textarea = screen.getByPlaceholderText("修正依頼を入力（必須）");
    fireEvent.change(textarea, { target: { value: "CIが失敗しています" } });
    fireEvent.click(screen.getByRole("button", { name: "修正を依頼する" }));
    expect(onRequestPrFix).toHaveBeenCalledWith("CIが失敗しています");
  });

  it("修正依頼を送れない画面（onRequestPrFixなし）では入力欄を出さない", () => {
    const { container } = renderActions({ onRequestPrFix: undefined });
    expect(container.textContent).toBe("");
  });
});

/**
 * #2849。マージを押す直前に、自動レビューが何を指摘したのかを読み、そのまま修正依頼へ
 * 渡せるようにする。**取り込みはGitHubへ何も送らない**——入るのは入力欄までで、
 * 送るのは「修正を依頼する」を押したとき。
 */
describe("MergeApprovalActions レビュー指摘の取り込み", () => {
  afterEach(() => {
    cleanup();
  });

  it("対象PRが分からなければパネルを出さない", () => {
    renderActions();
    expect(screen.queryByText("コードレビュー")).toBeNull();
  });

  it("取得中はパネルを出さない（「記録がありません」を一瞬出さないため）", () => {
    renderActions({ reviewPullRequestNumber: 2851, isLoadingReview: true });
    expect(screen.queryByText("コードレビュー")).toBeNull();
  });

  it("取り込むと入力欄が引用で埋まり、その内容がそのまま送られる", () => {
    const onRequestPrFix = vi.fn();
    renderActions({ review, reviewPullRequestNumber: 2851, onRequestPrFix });

    fireEvent.click(screen.getByRole("button", { name: "指摘を修正依頼に取り込む" }));
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>("修正依頼を入力（必須）");
    expect(textarea.value).toContain("自動レビュー（PR #2851・要修正）");
    expect(textarea.value).toContain("> - `a.ts:1` を直す");

    fireEvent.click(screen.getByRole("button", { name: "修正を依頼する" }));
    expect(onRequestPrFix).toHaveBeenCalledWith(textarea.value);
  });

  it("書きかけの依頼は消さず、後ろへ足す", () => {
    renderActions({ review, reviewPullRequestNumber: 2851 });
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>("修正依頼を入力（必須）");
    fireEvent.change(textarea, { target: { value: "ついでにテストも足してください" } });

    fireEvent.click(screen.getByRole("button", { name: "指摘を修正依頼に取り込む" }));
    expect(textarea.value).toContain("ついでにテストも足してください");
    expect(textarea.value).toContain("自動レビュー（PR #2851・要修正）");
  });
});

/**
 * 送り先による出し分け（#2919）。`11.local`が付いている間、`@claude`コメントは無人実行に
 * 届かないため、押す前に「どこへ何が送られるのか」が読めることを確かめる。
 */
describe("MergeApprovalActions 修正依頼の送り先", () => {
  afterEach(() => {
    cleanup();
  });

  it("無人実行が担当のときは案内を出さず、文言も従来どおり", () => {
    renderActions({ prFixRoute: { kind: "actions" } });
    expect(screen.getByRole("button", { name: "修正を依頼する" })).not.toBeNull();
    expect(screen.queryByText(/セッションが担当中/)).toBeNull();
  });

  it("セッションが担当中なら、送る1行まで押す前に出す", () => {
    renderActions({ prFixRoute: { kind: "session", host: "subpc" } });
    expect(screen.getByRole("button", { name: "セッションへ送る" })).not.toBeNull();
    expect(screen.getByText(/セッションが担当中/)).not.toBeNull();
    expect(screen.getByText(new RegExp(PR_FIX_SESSION_INSTRUCTION))).not.toBeNull();
  });

  it("セッションへ送れない理由があるときは、理由を出して押せなくする", () => {
    renderActions({
      prFixRoute: { kind: "session", host: "subpc" },
      prFixSessionRejection: "サブPC が応答していません。",
    });
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "セッションへ送る" });
    expect(button.disabled).toBe(true);
    expect(screen.getByText("サブPC が応答していません。")).not.toBeNull();
  });

  it("送信そのものが失敗した理由は出すが、書き直して送り直せる", () => {
    renderActions({
      prFixRoute: { kind: "session", host: "subpc" },
      prFixSessionError: "積めませんでした",
    });
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "セッションへ送る" });
    expect(button.disabled).toBe(false);
    expect(screen.getByText("積めませんでした")).not.toBeNull();
  });

  it("セッションが終了していれば、呼び戻すことをボタンにも書く", () => {
    renderActions({ prFixRoute: { kind: "resume", host: "subpc", agent: "claude" } });
    expect(screen.getByRole("button", { name: "セッションを再開して依頼する" })).not.toBeNull();
    expect(screen.getByText(/終了しています/)).not.toBeNull();
    // 呼び戻す側では固定の1行を送らない（プロンプトへ載るのは投稿したコメントの方）
    expect(screen.queryByText(new RegExp(PR_FIX_SESSION_INSTRUCTION))).toBeNull();
  });

  it("呼び戻せない理由があるときも、理由を出して押せなくする", () => {
    renderActions({
      prFixRoute: { kind: "resume", host: "subpc", agent: "claude" },
      prFixSessionRejection: "サブPC が応答していません。",
    });
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "セッションを再開して依頼する",
    });
    expect(button.disabled).toBe(true);
    expect(screen.getByText("サブPC が応答していません。")).not.toBeNull();
  });

  it("セッションの記録が無いときだけ、ラベルを外すことをボタンに書く", () => {
    renderActions({ prFixRoute: { kind: "handoff" } });
    expect(screen.getByRole("button", { name: "11.localを外して依頼する" })).not.toBeNull();
    expect(screen.getByText(/セッションの記録が見当たりません/)).not.toBeNull();
  });
});
