import { describe, expect, it } from "vitest";

import {
  buildCodeReviewFindingIssueDraft,
  buildCodeReviewIssueBody,
  buildCodeReviewTitle,
  CODE_REVIEW_REPORT_MARKER,
  CODE_REVIEW_REQUEST_MARKER,
  codeReviewRequestCommentBody,
  countCodeReviewFindings,
  findLatestCodeReviewReport,
  isCodeReviewIssue,
  isCodeReviewPending,
  isCodeReviewReportComment,
  parseCodeReviewReport,
} from "@/lib/github/code-review";

const REPORT = `${CODE_REVIEW_REPORT_MARKER}
読んだコード: guchi-apps/issue-deck origin/develop 9b25283b・2026-08-22

重い指摘が1件あります。ほかは既存の作りに合わせる範囲の直しです。

### [重大] 未完了ジョブの判定が種別を見ていない

- 種別: correctness
- 場所: \`src/lib/dispatch/dispatch-job.ts:412\`

\`hasActiveJob\`が\`activeKey\`の有無だけを見ています。

**直し方**: 種別で絞る。

### [軽微] 同じ絞り込みを2か所で組み立てている

- 場所: src/components/dashboard/issue-list.tsx:318

片方だけ直すとずれます。
`;

describe("buildCodeReviewTitle", () => {
  it("リポジトリ名と日本時間の日付でタイトルを組み立てる", () => {
    // UTCでは前日22:00。日本時間では8/22なので、そちらで入ること
    const title = buildCodeReviewTitle(
      "guchi-apps/issue-deck",
      new Date("2026-08-21T22:00:00.000Z"),
    );
    expect(title).toBe("[レビュー] issue-deck（2026-08-22）");
  });

  it("組み立てたタイトルはレビューIssueとして判定できる", () => {
    const title = buildCodeReviewTitle("guchi-apps/myroom", new Date("2026-08-22T03:00:00.000Z"));
    expect(isCodeReviewIssue({ title })).toBe(true);
    expect(isCodeReviewIssue({ title: "[質問] これは質問" })).toBe(false);
  });
});

describe("buildCodeReviewIssueBody", () => {
  it("観点が空でもリポジトリ全体を見ることが読める", () => {
    const body = buildCodeReviewIssueBody({
      repositoryFullName: "guchi-apps/issue-deck",
      focus: "   ",
    });
    expect(body).toContain("指定なし（リポジトリ全体を見る）");
  });

  it("観点を書いたときはそのまま載る", () => {
    const body = buildCodeReviewIssueBody({
      repositoryFullName: "guchi-apps/issue-deck",
      focus: "認証まわり",
    });
    expect(body).toContain("認証まわり");
  });
});

describe("codeReviewRequestCommentBody", () => {
  it("マーカーを付け、Actionsのトリガーになる`@claude`では始めない", () => {
    const body = codeReviewRequestCommentBody("認証まわり");
    expect(body).toContain(CODE_REVIEW_REQUEST_MARKER);
    expect(body).toContain("認証まわり");
    expect(body.startsWith("@claude")).toBe(false);
  });
});

describe("parseCodeReviewReport", () => {
  it("マーカーが無いコメントは読まない", () => {
    expect(parseCodeReviewReport("### [重大] これは普通のコメント")).toBeNull();
  });

  it("根拠・総評・指摘に分けて読む", () => {
    const report = parseCodeReviewReport(REPORT);
    expect(report).not.toBeNull();
    expect(report?.basis).toBe("guchi-apps/issue-deck origin/develop 9b25283b・2026-08-22");
    expect(report?.summary).toContain("重い指摘が1件あります");
    expect(report?.findings).toHaveLength(2);

    const [first, second] = report!.findings;
    expect(first.severity).toBe("high");
    expect(first.title).toBe("未完了ジョブの判定が種別を見ていない");
    expect(first.category).toBe("correctness");
    // コード表記で書かれていてもバッククォートは落とす
    expect(first.location).toBe("src/lib/dispatch/dispatch-job.ts:412");
    expect(first.body).toContain("**直し方**: 種別で絞る。");
    // 属性行は本文へ混ぜない
    expect(first.body).not.toContain("- 種別:");

    expect(second.severity).toBe("low");
    expect(second.category).toBeNull();
    expect(second.location).toBe("src/components/dashboard/issue-list.tsx:318");
  });

  it("重要度が3つのどれでもない見出しは指摘として扱わない", () => {
    const report = parseCodeReviewReport(
      `${CODE_REVIEW_REPORT_MARKER}\n\n### [提案] これは指摘ではない\n\n本文`,
    );
    expect(report?.findings).toHaveLength(0);
    // 拾えなくても結果そのものは残す（画面はMarkdownとして出す）
    expect(report?.summary).toContain("### [提案] これは指摘ではない");
  });

  it("指摘が1件も無い結果も読める", () => {
    const report = parseCodeReviewReport(
      `${CODE_REVIEW_REPORT_MARKER}\n読んだコード: origin/develop abc1234\n\n指摘はありませんでした。`,
    );
    expect(report?.findings).toEqual([]);
    expect(report?.summary).toBe("指摘はありませんでした。");
  });
});

describe("findLatestCodeReviewReport", () => {
  it("何度もレビューした場合は最後の結果を返す", () => {
    const older = `${CODE_REVIEW_REPORT_MARKER}\n\n### [中] 古い指摘\n\n本文`;
    const report = findLatestCodeReviewReport([
      { body: older },
      { body: "途中の雑談" },
      { body: REPORT },
    ]);
    expect(report?.findings[0]?.title).toBe("未完了ジョブの判定が種別を見ていない");
  });

  it("レビュー結果が無ければnull", () => {
    expect(findLatestCodeReviewReport([{ body: "ただのコメント" }])).toBeNull();
  });
});

describe("countCodeReviewFindings", () => {
  it("重要度ごとに数える", () => {
    const report = parseCodeReviewReport(REPORT);
    expect(countCodeReviewFindings(report!.findings)).toEqual({ high: 1, medium: 0, low: 1 });
  });
});

describe("isCodeReviewPending", () => {
  it("依頼のあとに結果が無ければレビュー中", () => {
    expect(isCodeReviewPending([{ body: codeReviewRequestCommentBody("") }])).toBe(true);
  });

  it("結果が返っていればレビュー中ではない", () => {
    expect(
      isCodeReviewPending([{ body: codeReviewRequestCommentBody("") }, { body: REPORT }]),
    ).toBe(false);
  });

  it("依頼コメントが無ければレビュー中ではない", () => {
    expect(isCodeReviewPending([{ body: "ただのコメント" }])).toBe(false);
  });
});

describe("isCodeReviewReportComment", () => {
  it("結果コメントだけを拾う", () => {
    expect(isCodeReviewReportComment({ body: REPORT })).toBe(true);
    expect(isCodeReviewReportComment({ body: codeReviewRequestCommentBody("") })).toBe(false);
  });
});

describe("buildCodeReviewFindingIssueDraft", () => {
  it("起票先はレビュー対象のリポジトリで、本文に起点と場所が残る", () => {
    const report = parseCodeReviewReport(REPORT);
    const draft = buildCodeReviewFindingIssueDraft({
      finding: report!.findings[0],
      repositoryFullName: "guchi-apps/issue-deck",
      reviewNumber: 2163,
    });
    expect(draft.repositoryFullName).toBe("guchi-apps/issue-deck");
    expect(draft.title).toBe("未完了ジョブの判定が種別を見ていない");
    expect(draft.body).toContain("- 重要度: 重大");
    expect(draft.body).toContain("`src/lib/dispatch/dispatch-job.ts:412`");
    expect(draft.body).toContain("- 起点のレビュー: #2163");
    // Actionsの`@claude`トリガーを誤爆させない
    expect(draft.body.startsWith("@claude")).toBe(false);
  });
});
