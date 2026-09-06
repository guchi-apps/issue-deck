import { describe, expect, it } from "vitest";

import {
  buildReviewFixRequestText,
  extractReviewConcerns,
  selectPullRequestReviewComment,
  selectReviewTargetPullRequestNumber,
  type PullRequestReviewCommentSource,
} from "@/lib/github/pull-request-review-comment";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_SHA = "89abcdef0123456789abcdef0123456789abcdef";

function comment(
  body: string | null,
  overrides: Partial<PullRequestReviewCommentSource> = {},
): PullRequestReviewCommentSource {
  return {
    body,
    createdAt: "2026-09-06T10:00:00Z",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/2851#issuecomment-1",
    ...overrides,
  };
}

/** レビュー本体が投稿するコメントそのままの形（`.github/prompts/review-develop.md`） */
function reviewBody(verdict: string, sha: string, note = "気になった点はありません。"): string {
  return [
    "## 総評",
    "",
    note,
    "",
    `<!-- issue-deck-review-verdict:${verdict} sha=${sha} -->`,
  ].join("\n");
}

describe("selectPullRequestReviewComment", () => {
  it("レビューのコメントが1件も無ければnullを返す", () => {
    expect(selectPullRequestReviewComment([], HEAD_SHA)).toBeNull();
    expect(
      selectPullRequestReviewComment(
        [comment("実装しました。"), comment(null), comment("CIを直しました。")],
        HEAD_SHA,
      ),
    ).toBeNull();
  });

  it("判定マーカーから判定・文言を読み、マーカー行は本文から落とす", () => {
    const result = selectPullRequestReviewComment(
      [comment(reviewBody("changes-requested", HEAD_SHA, "- `a.ts:1` を直してください。"))],
      HEAD_SHA,
    );

    expect(result).not.toBeNull();
    expect(result?.verdictKind).toBe("changes-requested");
    expect(result?.verdictLabel).toBe("要修正");
    expect(result?.body).toBe("## 総評\n\n- `a.ts:1` を直してください。");
    expect(result?.reviewedSha).toBe(HEAD_SHA);
    expect(result?.isStale).toBe(false);
  });

  it("`lgtm`は画面の判定`ok`へ読み替える", () => {
    const result = selectPullRequestReviewComment([comment(reviewBody("lgtm", HEAD_SHA))], HEAD_SHA);
    expect(result?.verdictKind).toBe("ok");
    expect(result?.verdictLabel).toBe("問題なし（LGTM）");
  });

  it("headと同じコミットへのレビューが複数あれば最後のものを選ぶ", () => {
    const result = selectPullRequestReviewComment(
      [
        comment(reviewBody("changes-requested", HEAD_SHA, "1回目")),
        comment("実装しました。"),
        comment(reviewBody("lgtm", HEAD_SHA, "2回目")),
      ],
      HEAD_SHA,
    );

    expect(result?.verdictKind).toBe("ok");
    expect(result?.body).toContain("2回目");
  });

  it("headより古いコミットへのレビューしか無ければ、それを`isStale`付きで返す", () => {
    const result = selectPullRequestReviewComment(
      [comment(reviewBody("changes-requested", OLD_SHA, "古い指摘"))],
      HEAD_SHA,
    );

    expect(result?.isStale).toBe(true);
    expect(result?.reviewedSha).toBe(OLD_SHA);
    expect(result?.body).toContain("古い指摘");
  });

  it("headと一致するレビューがあれば、後から投稿された古いコミットへのレビューより優先する", () => {
    const result = selectPullRequestReviewComment(
      [
        comment(reviewBody("lgtm", HEAD_SHA, "いまの中身へのレビュー")),
        comment(reviewBody("changes-requested", OLD_SHA, "古いコミットへのレビュー")),
      ],
      HEAD_SHA,
    );

    expect(result?.isStale).toBe(false);
    expect(result?.body).toContain("いまの中身へのレビュー");
  });

  it("headが分からないときは古いとは言わない", () => {
    const result = selectPullRequestReviewComment(
      [comment(reviewBody("needs-check", OLD_SHA))],
      null,
    );

    expect(result?.isStale).toBe(false);
    expect(result?.verdictKind).toBe("needs-check");
  });

  it("転記されたレビュー（#2488）は判定なしで拾う", () => {
    const result = selectPullRequestReviewComment(
      [
        comment(
          [
            "🤖 **自動レビューの結果**（レビュー本体が投稿できなかったため、ワークフローが実行ログから転記しました）",
            "",
            "要修正です。",
            "",
            "<!-- issue-deck-source:claude-review-develop -->",
            `<!-- issue-deck-review-report sha=${HEAD_SHA} -->`,
          ].join("\n"),
        ),
      ],
      HEAD_SHA,
    );

    expect(result?.verdictKind).toBe("unknown");
    expect(result?.verdictLabel).toBe("判定の記録なし");
    expect(result?.body).toContain("要修正です。");
    expect(result?.body).not.toContain("issue-deck-source");
  });

  it("マーカーだけで本文が空のコメントは採らない", () => {
    expect(
      selectPullRequestReviewComment(
        [comment(`<!-- issue-deck-review-verdict:lgtm sha=${HEAD_SHA} -->`)],
        HEAD_SHA,
      ),
    ).toBeNull();
  });
});

describe("extractReviewConcerns", () => {
  it("「気になった点」以降だけを取り出す（総評・良かった点は落とす）", () => {
    const body = [
      "## 総評: 要修正",
      "",
      "要件は満たしています。",
      "",
      "### 良かった点",
      "",
      "- テストが厚い",
      "",
      "## 気になった点",
      "",
      "- `a.ts:1` を直す",
    ].join("\n");

    expect(extractReviewConcerns(body)).toBe("## 気になった点\n\n- `a.ts:1` を直す");
  });

  it("太字の見出しでも拾う", () => {
    const body = "総評: 要修正\n\n**気になった点**\n\n- `a.ts:1` を直す";
    expect(extractReviewConcerns(body)).toBe("**気になった点**\n\n- `a.ts:1` を直す");
  });

  it("見出しが無ければ本文全部を渡す（絞れないときに空にしない）", () => {
    const body = "要修正です。`a.ts:1`を直してください。";
    expect(extractReviewConcerns(body)).toBe(body);
  });
});

describe("buildReviewFixRequestText", () => {
  it("本文を引用にして、どのPRのどの判定かを先頭に書く", () => {
    const text = buildReviewFixRequestText({
      review: { body: "## 気になった点\n\n- `a.ts:1` を直す", verdictLabel: "要修正" },
      pullRequestNumber: 2851,
    });

    expect(text).toBe(
      [
        "自動レビュー（PR #2851・要修正）で指摘された次の点を修正してください。",
        "",
        "> ## 気になった点",
        ">",
        "> - `a.ts:1` を直す",
        "",
      ].join("\n"),
    );
  });

  it("長い本文は切り、続きの読み先を書く", () => {
    const text = buildReviewFixRequestText({
      review: { body: Array.from({ length: 200 }, (_, i) => `- 指摘${i}`).join("\n"), verdictLabel: "要修正" },
      pullRequestNumber: 1,
    });

    expect(text).toContain("（長いため以降を省略しました。全文はPRのレビューコメントにあります）");
    expect(text.split("\n").filter((line) => line.startsWith("> - 指摘")).length).toBe(60);
  });
});

describe("selectReviewTargetPullRequestNumber", () => {
  function pullRequest(
    number: number,
    overrides: Partial<{ state: "open" | "closed"; merged: boolean; draft: boolean }> = {},
  ) {
    return { number, state: "open" as const, merged: false, draft: false, ...overrides };
  }

  it("openでマージ済みでないPRのうち、番号がいちばん小さいものを選ぶ", () => {
    expect(
      selectReviewTargetPullRequestNumber([pullRequest(2860), pullRequest(2851)]),
    ).toBe(2851);
  });

  it("マージ済み・クローズ済み・ドラフトは選ばない", () => {
    expect(
      selectReviewTargetPullRequestNumber([
        pullRequest(2840, { state: "closed", merged: true }),
        pullRequest(2845, { state: "closed" }),
        pullRequest(2850, { draft: true }),
        pullRequest(2851),
      ]),
    ).toBe(2851);
  });

  it("対象が無ければnull（パネルを出さない）", () => {
    expect(selectReviewTargetPullRequestNumber([])).toBeNull();
    expect(
      selectReviewTargetPullRequestNumber([pullRequest(2840, { state: "closed", merged: true })]),
    ).toBeNull();
  });
});
