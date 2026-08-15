// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommentThread } from "@/components/dashboard/comment-thread";
import type { IssueCommentSummaries } from "@/hooks/use-issue-comment-summaries";
import type { IssueComment } from "@/types/issue";

const commentSummary: IssueCommentSummaries = {
  summaries: {},
  generatingIds: new Set(),
  errors: {},
  notConfigured: false,
  generate: async () => {},
};

function makeComment(overrides: Partial<IssueComment>): IssueComment {
  return {
    id: "1",
    author: { login: "m-guchi" },
    createdAtLabel: "1時間前",
    body: "コメント本文",
    reactionCount: 0,
    ...overrides,
  };
}

function renderThread(comments: IssueComment[]) {
  return render(
    <CommentThread
      comments={comments}
      repositoryFullName="m-guchi/issue-deck"
      issueSuggestions={[]}
      onUpdate={async () => true}
      onDelete={async () => true}
      commentSummary={commentSummary}
    />,
  );
}

describe("CommentThread ボットの役割表示", () => {
  afterEach(() => {
    cleanup();
  });

  it("issue-deck-sourceマーカー付きのbotコメントはヘッダに役割の表示名を表示する", () => {
    renderThread([
      makeComment({
        author: { login: "github-actions[bot]" },
        body: "対応完了しました\n\n<!-- issue-deck-source:issue-labels -->",
      }),
    ]);
    expect(screen.getByText("進捗通知ボット")).not.toBeNull();
  });

  it("計画コメントはヘッダに計画ボットを表示する", () => {
    renderThread([
      makeComment({
        author: { login: "github-actions[bot]" },
        body: "計画本文\n\n<!-- issue-deck-plan-type:split -->",
      }),
    ]);
    expect(screen.getByText("分割ボット")).not.toBeNull();
  });

  it("issue-deck-agentマーカー付きのbotコメントはヘッダに役割の表示名を表示する", () => {
    renderThread([
      makeComment({
        author: { login: "github-actions[bot]" },
        body: "着手します\n\n<!-- issue-deck-agent:implementer -->\n\n<!-- issue-deck-source:claude-issue-dispatch -->",
      }),
    ]);
    expect(screen.getByText("実装ボット")).not.toBeNull();
  });

  it("人間のコメントにはヘッダにloginをそのまま表示する", () => {
    renderThread([makeComment({ author: { login: "m-guchi" }, body: "通常のコメント" })]);
    expect(screen.getByText("m-guchi")).not.toBeNull();
  });

  it("マーカーの無いbotコメントにはヘッダにloginをそのまま表示する（汎用ボット扱い）", () => {
    renderThread([
      makeComment({ author: { login: "github-actions[bot]" }, body: "マーカーの無いコメント" }),
    ]);
    expect(screen.getByText("github-actions[bot]")).not.toBeNull();
  });
});

describe("CommentThread 左右の吹き出し", () => {
  afterEach(() => {
    cleanup();
  });

  it("currentUserLoginと一致するコメントは右寄せの吹き出しになる", () => {
    render(
      <CommentThread
        comments={[makeComment({ author: { login: "m-guchi" }, body: "自分のコメント" })]}
        currentUserLogin="m-guchi"
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
      />,
    );
    const row = screen.getByText("自分のコメント").closest("li")?.querySelector(":scope > div");
    expect(row?.className).toContain("flex-row-reverse");
  });

  it("currentUserLoginと一致しないコメントは左寄せのままになる", () => {
    render(
      <CommentThread
        comments={[makeComment({ author: { login: "other-user" }, body: "他の人のコメント" })]}
        currentUserLogin="m-guchi"
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
      />,
    );
    const row = screen.getByText("他の人のコメント").closest("li")?.querySelector(":scope > div");
    expect(row?.className).not.toContain("flex-row-reverse");
  });

  // ローカル（サブPC）セッションのコメントは`gh`がユーザー本人のトークンで動くため、
  // currentUserLoginと同じlogin名で投稿される（#1346）
  it("currentUserLoginと一致してもagentマーカー付きならボットとして左寄せになる", () => {
    render(
      <CommentThread
        comments={[
          makeComment({
            author: { login: "m-guchi" },
            body: "実装が完了しました\n\n<!-- issue-deck-agent:implementer -->",
          }),
        ]}
        currentUserLogin="m-guchi"
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
      />,
    );
    const row = screen.getByText("実装が完了しました").closest("li")?.querySelector(":scope > div");
    expect(row?.className).not.toContain("flex-row-reverse");
    expect(screen.getByText("実装ボット")).not.toBeNull();
  });

  it("currentUserLoginと一致し書き出しが絵文字なだけのコメントは右寄せのままになる", () => {
    render(
      <CommentThread
        comments={[makeComment({ author: { login: "m-guchi" }, body: "🔧 自分で直しました" })]}
        currentUserLogin="m-guchi"
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
      />,
    );
    const row = screen.getByText("🔧 自分で直しました").closest("li")?.querySelector(":scope > div");
    expect(row?.className).toContain("flex-row-reverse");
    expect(screen.getByText("m-guchi")).not.toBeNull();
  });

  // カンバンのドラッグ起点の起動コメントは、操作した人間へ寄せて表示する（#1026）
  it("project-status-dispatchマーカー付きコメントは自分の名義なら右寄せのままになる", () => {
    render(
      <CommentThread
        comments={[
          makeComment({
            author: { login: "m-guchi" },
            body: "@claude 実装を開始してください\n\n<!-- issue-deck-source:project-status-dispatch -->",
          }),
        ]}
        currentUserLogin="m-guchi"
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
      />,
    );
    const row = screen
      .getByText("@claude 実装を開始してください")
      .closest("li")
      ?.querySelector(":scope > div");
    expect(row?.className).toContain("flex-row-reverse");
  });
});

describe("CommentThread AI要約の表示位置", () => {
  afterEach(() => {
    cleanup();
  });

  it("長文コメントではAI要約を本文より前に表示する", () => {
    const body = `本文の先頭${"あ".repeat(500)}`;
    renderThread([makeComment({ body })]);

    const summaryLabel = screen.getByText("AI要約");
    const bodyText = screen.getByText(body);
    // Node.DOCUMENT_POSITION_FOLLOWING: summaryLabel より後ろに bodyText がある
    expect(summaryLabel.compareDocumentPosition(bodyText) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("短いコメントにはAI要約を表示しない", () => {
    renderThread([makeComment({ body: "短いコメント" })]);

    expect(screen.queryByText("AI要約")).toBeNull();
  });
});

describe("CommentThread PRマージ待ちの表示", () => {
  afterEach(() => {
    cleanup();
  });

  it("自動マージされなかった理由を案内の下に出し、マージ後は出さない（#1631）", async () => {
    render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        mergeApprovalPending
        mergeCheckReasons={{
          source: "review",
          items: ["GitHub Actionsワークフローの変更 (.github/workflows/**)"],
          postedAtLabel: "3分前",
        }}
        pullRequestLinks={[{ number: 674, url: "https://github.com/m-guchi/issue-deck/pull/674" }]}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onMergePullRequest={async () => true}
      />,
    );

    expect(screen.getByText("自動マージされなかった理由")).not.toBeNull();
    expect(screen.getByText("GitHub Actionsワークフローの変更 (.github/workflows/**)")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /マージする/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /マージする/ }).at(-1)!);

    await waitFor(() => {
      expect(screen.getByText("Pull Requestをマージしました")).not.toBeNull();
    });
    // マージし終えた後も理由が残ると、まだ操作が要るように読める
    expect(screen.queryByText("自動マージされなかった理由")).toBeNull();
  });

  it("マージ実行後は「マージが必要です」ではなく完了の表示に切り替わる", async () => {
    render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        mergeApprovalPending
        pullRequestLinks={[{ number: 674, url: "https://github.com/m-guchi/issue-deck/pull/674" }]}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={async () => {}}
        onMergePullRequest={async () => true}
      />,
    );

    expect(screen.getByText("Pull Requestのマージが必要です")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /マージする/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /マージする/ }).at(-1)!);

    await waitFor(() => {
      expect(screen.getByText("Pull Requestをマージしました")).not.toBeNull();
    });
    expect(screen.queryByText("Pull Requestのマージが必要です")).toBeNull();
    expect(screen.queryByText("修正を依頼する")).toBeNull();
  });

  it("この欄からマージするとonPullRequestMergedで親へ伝える（#1288: 本文の上の対応PR一覧と状態を揃える）", async () => {
    const onPullRequestMerged = vi.fn();
    render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        mergeApprovalPending
        pullRequestLinks={[{ number: 674, url: "https://github.com/m-guchi/issue-deck/pull/674" }]}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={async () => {}}
        onMergePullRequest={async () => true}
        onPullRequestMerged={onPullRequestMerged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /マージする/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /マージする/ }).at(-1)!);

    await waitFor(() => {
      expect(onPullRequestMerged).toHaveBeenCalledWith(674);
    });
  });

  it("本文の上のマージボタンから押された場合（mergedPullRequestNumbers）もマージ済みの表示になる（#1288・#1339）", () => {
    render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        mergeApprovalPending
        pullRequestLinks={[{ number: 674, url: "https://github.com/m-guchi/issue-deck/pull/674" }]}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={async () => {}}
        onMergePullRequest={async () => true}
        mergedPullRequestNumbers={new Set([674])}
      />,
    );

    expect(screen.getByText("Pull Requestをマージしました")).not.toBeNull();
    expect(screen.queryByText("修正を依頼する")).toBeNull();
    const button = screen.getByRole("button", { name: /マージ済み/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("CommentThread PRマージ待ちのCI状態とマージボタン", () => {
  afterEach(() => {
    cleanup();
  });

  function renderMergePendingWithCiStatus(
    pullRequestCiStatus: "in_progress" | "success" | "failure" | "none" | null,
  ) {
    return render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        mergeApprovalPending
        pullRequestLinks={[{ number: 674, url: "https://github.com/m-guchi/issue-deck/pull/674" }]}
        pullRequests={[
          {
            number: 674,
            htmlUrl: "https://github.com/m-guchi/issue-deck/pull/674",
            title: "対応PRのタイトル",
            state: "open",
            draft: false,
            merged: false,
            ciStatus: pullRequestCiStatus,
            linkedIssueNumber: 1288,
          },
        ]}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={async () => {}}
        onMergePullRequest={async () => true}
      />,
    );
  }

  it("CI実行中はマージするボタンがdisabledになる", () => {
    renderMergePendingWithCiStatus("in_progress");
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("CI成功時はマージするボタンがdisabledにならない", () => {
    renderMergePendingWithCiStatus("success");
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("CI失敗時はマージするボタンがdisabledにならない", () => {
    renderMergePendingWithCiStatus("failure");
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("CI状態が取得できない場合はマージするボタンがdisabledにならない", () => {
    renderMergePendingWithCiStatus(null);
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("マージ操作エリアと修正依頼エリアの間にディバイダーが表示される", () => {
    renderMergePendingWithCiStatus("success");
    const separator = document.querySelector('[data-slot="separator"]');
    expect(separator).not.toBeNull();
  });

  it("マージするボタンはopacityを含む全プロパティのtransitionを使わない（#1115: CIバッジ出現によるレイアウト移動とdisabled化のopacity transitionが重なり、モバイルSafariでボタンが二重表示される不具合の再発防止）", () => {
    renderMergePendingWithCiStatus("in_progress");
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.className).not.toMatch(/(?:^|\s)transition-all(?:\s|$)/);
    expect(button.className).toMatch(/(?:^|\s)transition-colors(?:\s|$)/);
  });
});

describe("CommentThread 承認カードのテキスト入力", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderApproval(overrides: {
    onApprove: (text?: string) => void;
    onReject: (reason: string) => void;
  }) {
    return render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        onApprove={overrides.onApprove}
        onReject={overrides.onReject}
        onWithdraw={async () => {}}
      />,
    );
  }

  it("テキスト入力欄と音声入力を整理ボタンが常設表示される", () => {
    renderApproval({ onApprove: () => {}, onReject: () => {} });
    expect(
      screen.getByPlaceholderText("コメントを入力（承認は任意、修正は入力必須）"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /音声入力を整理/ })).not.toBeNull();
  });

  it("修正ボタンは空文字のままだと送信されずエラー文言を表示する", () => {
    const onReject = vi.fn();
    renderApproval({ onApprove: () => {}, onReject });
    fireEvent.click(screen.getByRole("button", { name: "修正" }));
    expect(screen.getByText("修正内容を入力してください")).not.toBeNull();
    expect(onReject).not.toHaveBeenCalled();
  });

  it("修正ボタンは入力ありでonReject(text)を呼ぶ", () => {
    const onReject = vi.fn();
    renderApproval({ onApprove: () => {}, onReject });
    const textarea = screen.getByPlaceholderText(
      "コメントを入力（承認は任意、修正は入力必須）",
    );
    fireEvent.change(textarea, { target: { value: "ここを直してください" } });
    fireEvent.click(screen.getByRole("button", { name: "修正" }));
    expect(onReject).toHaveBeenCalledWith("ここを直してください");
  });

  it("承認ボタンは入力が空ならonApprove()を引数なしで呼ぶ", () => {
    const onApprove = vi.fn();
    renderApproval({ onApprove, onReject: () => {} });
    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    expect(onApprove).toHaveBeenCalledWith(undefined);
  });

  it("承認ボタンは入力があればonApprove(text)を呼ぶ", () => {
    const onApprove = vi.fn();
    renderApproval({ onApprove, onReject: () => {} });
    const textarea = screen.getByPlaceholderText(
      "コメントを入力（承認は任意、修正は入力必須）",
    );
    fireEvent.change(textarea, { target: { value: "次のステップへ進んでください" } });
    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    expect(onApprove).toHaveBeenCalledWith("次のステップへ進んでください");
  });
});

describe("CommentThread PRマージ待ちの修正を依頼するテキスト入力", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderMergePending(onRequestPrFix: (reason: string) => void) {
    return render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        mergeApprovalPending
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={onRequestPrFix}
        onMergePullRequest={async () => true}
      />,
    );
  }

  it("入力欄が常設表示される", () => {
    renderMergePending(() => {});
    expect(screen.getByPlaceholderText("修正依頼を入力（必須）")).not.toBeNull();
  });

  it("空文字では修正を依頼するが送信されずエラー文言が出る", () => {
    const onRequestPrFix = vi.fn();
    renderMergePending(onRequestPrFix);
    fireEvent.click(screen.getByRole("button", { name: "修正を依頼する" }));
    expect(screen.getByText("修正内容を入力してください")).not.toBeNull();
    expect(onRequestPrFix).not.toHaveBeenCalled();
  });

  it("入力ありでonRequestPrFix(text)が呼ばれる", () => {
    const onRequestPrFix = vi.fn();
    renderMergePending(onRequestPrFix);
    const textarea = screen.getByPlaceholderText("修正依頼を入力（必須）");
    fireEvent.change(textarea, { target: { value: "CIが失敗しています" } });
    fireEvent.click(screen.getByRole("button", { name: "修正を依頼する" }));
    expect(onRequestPrFix).toHaveBeenCalledWith("CIが失敗しています");
  });
});

/**
 * #1417。走っているローカルセッションが入力待ちの間は、承認・修正を押しても
 * コメントが残るだけでセッションには届かない（`11.local`で無人実行も動かない）。
 * ボタンを引っ込め、唯一効く出口である案内だけを出す。
 */
describe("CommentThread セッションが入力待ちのとき", () => {
  afterEach(() => {
    cleanup();
  });

  function renderWaitingInput(overrides: { mergeApprovalPending?: boolean } = {}) {
    return render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        sessionWaitingInput
        localSessionNotice={<p>Remote Controlから伝えてください</p>}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={async () => {}}
        mergeApprovalPending={overrides.mergeApprovalPending}
      />,
    );
  }

  it("承認・修正・取り下げボタンの代わりに案内を出す", () => {
    renderWaitingInput();
    expect(screen.getByText("セッションが入力を待っています")).not.toBeNull();
    expect(screen.getByText("Remote Controlから伝えてください")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
    expect(screen.queryByRole("button", { name: "修正" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取り下げ" })).toBeNull();
  });

  // PRのマージはGitHub側の操作で、`11.local`中でも実際に効く。そちらを優先する
  it("PRマージ待ちのときはマージ案内を優先する", () => {
    renderWaitingInput({ mergeApprovalPending: true });
    expect(screen.getByText("Pull Requestのマージが必要です")).not.toBeNull();
    expect(screen.queryByText("セッションが入力を待っています")).toBeNull();
  });
});

describe("CommentThread 承認カードの見出し（#1490）", () => {
  afterEach(() => {
    cleanup();
  });

  function renderApprovalCard(reason?: "plan" | "input" | "blocked" | "answered") {
    return render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        checkUserReason={reason ?? null}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
      />,
    );
  }

  it("理由ラベルが読めれば、何を求められているかを見出しに出す", () => {
    renderApprovalCard("plan");
    expect(screen.getByText("計画の承認が必要です")).not.toBeNull();
  });

  it("理由ラベルが配られていないリポジトリでは従来の見出しに戻る", () => {
    renderApprovalCard();
    expect(screen.getByText("ユーザーの承認が必要です")).not.toBeNull();
  });
});

/**
 * #1639。承認・PRマージのカードは「最後のbotコメント」の直下に差し込んでいたが、
 * その判定はissue-deckのGitHub Appのlogin名だけを見ており、`github-actions[bot]`名義の
 * 進捗通知やローカルセッションの報告（ユーザー本人のlogin名で投稿される・#1346）が
 * 後に続くと、カードが一覧の途中に埋もれていた。常に末尾へ出す。
 */
describe("CommentThread 承認カードの表示位置（#1639）", () => {
  // カードを差し込む位置の判定は`issue-deck[bot]`のlogin名を見ていたため、
  // App slugを設定しないと不具合を再現できない
  const originalSlug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = "issue-deck";
  });

  afterEach(() => {
    if (originalSlug === undefined) delete process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
    else process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = originalSlug;
    cleanup();
  });

  function renderWithTrailingComments(props: { mergeApprovalPending?: boolean } = {}) {
    return render(
      <CommentThread
        comments={[
          makeComment({
            id: "1",
            author: { login: "issue-deck[bot]" },
            body: "🔍 計画を作成しました\n\n<!-- issue-deck-plan-type:implement -->",
          }),
          makeComment({
            id: "2",
            author: { login: "github-actions[bot]" },
            body: "進捗を更新しました\n\n<!-- issue-deck-source:issue-labels -->",
          }),
          makeComment({
            id: "3",
            author: { login: "m-guchi" },
            body: "最後のコメント本文",
          }),
        ]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        mergeApprovalPending={props.mergeApprovalPending}
        pullRequestLinks={[{ number: 674, url: "https://github.com/m-guchi/issue-deck/pull/674" }]}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={async () => {}}
        onMergePullRequest={async () => true}
      />,
    );
  }

  it("PRマージ待ちのカードは最後のコメントより後ろに表示する", () => {
    renderWithTrailingComments({ mergeApprovalPending: true });

    const lastComment = screen.getByText("最後のコメント本文");
    const card = screen.getByText("Pull Requestのマージが必要です");
    // Node.DOCUMENT_POSITION_FOLLOWING: lastComment より後ろに card がある
    expect(lastComment.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // コメント一覧の項目の中ではなく、一覧の外（末尾）に出す
    expect(card.closest("li")).toBeNull();
  });

  it("承認待ちのカードも最後のコメントより後ろに表示する", () => {
    renderWithTrailingComments();

    const lastComment = screen.getByText("最後のコメント本文");
    const card = screen.getByText("ユーザーの承認が必要です");
    expect(lastComment.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(card.closest("li")).toBeNull();
  });
});
