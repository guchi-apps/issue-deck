// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
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

// #2309: 状態カードのバッジはコメントを読み下げると画面の外へ出てしまい、
// 質問した本人が「投げたきり返ってこない」のか「まだ処理中」なのかを読めなかった
describe("CommentThread 回答待ちの吹き出し（#2309）", () => {
  afterEach(() => {
    cleanup();
  });

  function renderWithPending(qaAnswerPending: boolean) {
    render(
      <CommentThread
        comments={[makeComment({ body: "この作業はpollerを止めずにできますか？" })]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        qaAnswerPending={qaAnswerPending}
      />,
    );
  }

  it("回答待ちなら一覧の末尾に回るアイコンつきの吹き出しを出す", () => {
    renderWithPending(true);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("回答待ち");
    expect(status.parentElement?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("回答待ちでなければ出さない", () => {
    renderWithPending(false);

    expect(screen.queryByRole("status")).toBeNull();
  });
});

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

  // 計画レビュー（G1）の指摘に応えたコメント。実装セッションが本人名義で投稿するため、
  // 専用マーカーが無かった間は右寄せの本人の発言として並んでいた（#2864）
  it("plan-reviserマーカー付きのコメントはレビュー反映ボットとして左寄せになる", () => {
    render(
      <CommentThread
        comments={[
          makeComment({
            author: { login: "m-guchi" },
            body: "計画レビューの指摘を反映しました\n\n<!-- issue-deck-agent:plan-reviser -->",
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
      .getByText("計画レビューの指摘を反映しました")
      .closest("li")
      ?.querySelector(":scope > div");
    expect(row?.className).not.toContain("flex-row-reverse");
    expect(screen.getByText("レビュー反映ボット")).not.toBeNull();
    // 計画ボット（琥珀）・レビューボット（藍）と並んだときに見分けられること
    const bubble = screen.getByText("計画レビューの指摘を反映しました").closest("div.rounded-lg");
    expect(bubble?.className).toContain("border-pink-500/30");
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

/**
 * #2914。マージ待ちの操作一式（PRの行・マージボタン・自動マージされなかった理由・
 * レビュー本文・修正依頼欄）は画面上部の対応PRセクションへ移した。ここに残るのは
 * 「どこへ行けばよいか」だけ。
 */
describe("CommentThread PRマージ待ちの表示", () => {
  afterEach(() => {
    cleanup();
  });

  function renderMergePending(props: Partial<ComponentProps<typeof CommentThread>> = {}) {
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
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={async () => {}}
        {...props}
      />,
    );
  }

  it("マージボタン・レビュー本文・修正依頼欄をここには出さない（#2914）", () => {
    renderMergePending({
      reviewFindings: {
        verdictKind: "changes-requested",
        verdictLabel: "要修正",
        body: "- `a.ts:1` を直す",
        createdAt: new Date().toISOString(),
        htmlUrl: null,
        reviewedSha: "0123456",
        isStale: false,
      },
      reviewPullRequestNumber: 674,
    });

    expect(screen.getByText("Pull Requestのマージが必要です")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /マージする/ })).toBeNull();
    expect(screen.queryByText("コードレビュー")).toBeNull();
    expect(screen.queryByText("修正を依頼する")).toBeNull();
  });

  it("理由ラベルが読めれば「対応PRへ移動」で上部へ送る（#2914）", () => {
    renderMergePending({ checkUserReason: "merge" });
    expect(screen.getByRole("button", { name: /対応PRへ移動/ })).not.toBeNull();
  });

  // 対応PRの行が1件も無いIssueでは飛ぶ先が無いため、ここが唯一の修正依頼の出口になる
  it("上部に対応PRセクションが無いときだけ、修正依頼欄をここに出す（#2914）", () => {
    renderMergePending({ hasPullRequestSection: false });
    expect(screen.getByPlaceholderText("修正依頼を入力（必須）")).not.toBeNull();
    expect(screen.getByRole("button", { name: "修正を依頼する" })).not.toBeNull();
  });

  /**
   * その状態では画面のどこにもマージボタンが無い（`IssuePullRequestList`は行が0件だと
   * `null`を返すため、この変更の前からそうだった）。**案内が「下の『マージ』を押します」で
   * あってはいけない**——押せるものが無いことをそのまま書く（PR #2918のレビュー）。
   */
  it("対応PRセクションが無いときの案内は、マージ先としてGitHubを示す（#2914）", () => {
    renderMergePending({ hasPullRequestSection: false, checkUserReason: "merge" });
    expect(screen.queryByRole("button", { name: /マージする/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /対応PRへ移動/ })).toBeNull();
    expect(screen.getByText(/マージはGitHub上で行ってください/)).not.toBeNull();
  });

  /** 理由ラベルが読めないリポジトリ（`guidance`がnull）でも、押す場所の名指しは実態に合わせる */
  it("理由ラベルが無くても、対応PRセクションが無ければGitHubを示す（#2914）", () => {
    renderMergePending({ hasPullRequestSection: false });
    expect(screen.getByText(/GitHub上で内容を確認のうえマージしてください/)).not.toBeNull();

    cleanup();
    renderMergePending();
    expect(screen.getByText(/画面上部の「対応PR」で内容を確認のうえマージしてください/)).not.toBeNull();
  });

  it("上部のマージボタンから押された場合（mergedPullRequestNumbers）はマージ済みの表示になる（#1288・#1339）", () => {
    renderMergePending({ mergedPullRequestNumbers: new Set([674]), hasPullRequestSection: false });

    expect(screen.getByText("Pull Requestをマージしました")).not.toBeNull();
    expect(screen.queryByText("修正を依頼する")).toBeNull();
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

/**
 * #1810。セッションの状態（`/api/dispatch`）が届く前は`sessionWaitingInput`が必ずfalseになり、
 * 入力待ちのセッションでも承認・修正ボタンが一瞬出てから案内へ差し替わっていた。
 */
describe("CommentThread セッションの状態が届いていないとき", () => {
  afterEach(() => {
    cleanup();
  });

  function renderPending(overrides: { mergeApprovalPending?: boolean } = {}) {
    return render(
      <CommentThread
        comments={[]}
        repositoryFullName="m-guchi/issue-deck"
        issueSuggestions={[]}
        onUpdate={async () => true}
        onDelete={async () => true}
        commentSummary={commentSummary}
        approvalPending
        sessionStatePending
        checkUserReason="input"
        localSessionNotice={<p>Remote Controlから伝えてください</p>}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onRequestPrFix={async () => {}}
        mergeApprovalPending={overrides.mergeApprovalPending}
      />,
    );
  }

  it("承認カードをどちらの形でも出さない", () => {
    renderPending();
    expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
    expect(screen.queryByRole("button", { name: "修正" })).toBeNull();
    expect(screen.queryByText("質問への回答が必要です")).toBeNull();
    expect(screen.queryByText("セッションが入力を待っています")).toBeNull();
  });

  // マージ待ちの判定材料はラベルとコメントで、セッションの状態を待つ理由が無い
  it("PRマージ待ちはセッションの状態を待たずに出す", () => {
    renderPending({ mergeApprovalPending: true });
    expect(screen.getByText("Pull Requestのマージが必要です")).not.toBeNull();
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

/**
 * #1903。ローカルセッションが担当しているIssueでは、「承認」「修正」を押しても走っている
 * セッションには届かず、投稿される`@claude`コメントが無人実行を起こして「`11.local`が
 * 付いているため対応しません」という案内を足すだけだった。ここでできることの名前に
 * 置き換える（コメント／質問する／確認待ちを外す／取り下げ）。
 */
describe("CommentThread ローカルセッションが担当しているとき", () => {
  afterEach(() => {
    cleanup();
  });

  function renderLocal(
    props: {
      onComment?: (body: string) => void;
      onAskClaude?: (question: string) => void;
      onDismissCheckUser?: (text?: string) => void;
      mergeApprovalPending?: boolean;
      canAskClaude?: boolean;
    } = {},
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
        localSession
        sessionAlive
        canAskClaude={props.canAskClaude ?? true}
        checkUserReason="input"
        localSessionNotice={<p>ここに書いた回答はセッションに届きません</p>}
        onApprove={async () => {}}
        onReject={async () => {}}
        onWithdraw={async () => {}}
        onComment={props.onComment ?? (async () => {})}
        onAskClaude={props.onAskClaude ?? (async () => {})}
        onDismissCheckUser={props.onDismissCheckUser ?? (async () => {})}
        onRequestPrFix={async () => {}}
        mergeApprovalPending={props.mergeApprovalPending}
      />,
    );
  }

  it("承認・修正を出さず、コメント／質問する／確認待ちを外すを出す", () => {
    renderLocal();
    expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
    expect(screen.queryByRole("button", { name: "修正" })).toBeNull();
    expect(screen.getByRole("button", { name: "コメント" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "質問する" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "確認待ちを外す" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "取り下げ" })).not.toBeNull();
  });

  it("届かないことを入力欄の説明にも書く", () => {
    renderLocal();
    expect(
      screen.getByPlaceholderText("コメントを入力（記録として残ります。セッションには届きません）"),
    ).not.toBeNull();
  });

  it("入力があるときだけコメント・質問を押せる", () => {
    const onComment = vi.fn();
    renderLocal({ onComment });
    expect(screen.getByRole("button", { name: "コメント" })).toHaveProperty("disabled", true);
    fireEvent.change(
      screen.getByPlaceholderText("コメントを入力（記録として残ります。セッションには届きません）"),
      { target: { value: "あとで確認する" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "コメント" }));
    expect(onComment).toHaveBeenCalledWith("あとで確認する");
  });

  it("確認待ちを外すは入力が無くても押せる（印の片付けだけでも使う）", () => {
    const onDismissCheckUser = vi.fn();
    renderLocal({ onDismissCheckUser });
    fireEvent.click(screen.getByRole("button", { name: "確認待ちを外す" }));
    expect(onDismissCheckUser).toHaveBeenCalledWith(undefined);
  });

  it("入力があれば確認待ちを外すにも本文が渡る", () => {
    const onDismissCheckUser = vi.fn();
    renderLocal({ onDismissCheckUser });
    fireEvent.change(
      screen.getByPlaceholderText("コメントを入力（記録として残ります。セッションには届きません）"),
      { target: { value: "端末で回答済み" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "確認待ちを外す" }));
    expect(onDismissCheckUser).toHaveBeenCalledWith("端末で回答済み");
  });

  // マージはGitHub側の操作なので`11.local`中でも実際に効く（入力待ちの分岐と同じ扱い）
  it("PRマージ待ちのときはマージ案内を優先する", () => {
    renderLocal({ mergeApprovalPending: true });
    expect(screen.getByText("Pull Requestのマージが必要です")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "確認待ちを外す" })).toBeNull();
  });
});
