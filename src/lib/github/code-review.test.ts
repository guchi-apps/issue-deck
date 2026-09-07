import { describe, expect, it } from "vitest";

import {
  buildCodeReviewFindingIssueDraft,
  buildCodeReviewFindingIssueIndex,
  buildCodeReviewIssueBody,
  buildCodeReviewTitle,
  CODE_REVIEW_REPORT_MARKER,
  CODE_REVIEW_REQUEST_MARKER,
  codeReviewRequestCommentBody,
  countCodeReviewFindings,
  describeCodeReviewFindingProgress,
  filterUncreatedCodeReviewFindings,
  findLatestCodeReviewReport,
  formatCodeReviewListCount,
  isCodeReviewIssue,
  isCodeReviewPending,
  isCodeReviewReportComment,
  parseCodeReviewReport,
  summarizeCodeReviewComments,
  summarizeCodeReviewFindingProgress,
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

describe("buildCodeReviewFindingIssueIndex", () => {
  const issues = [
    { repositoryFullName: "guchi-apps/issue-deck", title: "同じ指摘", number: 2172 },
    { repositoryFullName: "guchi-apps/issue-deck", title: "同じ指摘", number: 2170 },
    { repositoryFullName: "guchi-apps/myroom", title: "別リポジトリの同名", number: 10 },
  ];

  it("同じリポジトリのタイトルだけを引き、先に立てた番号を返す", () => {
    const index = buildCodeReviewFindingIssueIndex(issues, "guchi-apps/issue-deck");
    expect(index.get("同じ指摘")).toBe(2170);
    expect(index.has("別リポジトリの同名")).toBe(false);
  });
});

describe("filterUncreatedCodeReviewFindings（#2859）", () => {
  it("索引が無ければすべて残す", () => {
    const report = parseCodeReviewReport(REPORT);
    expect(filterUncreatedCodeReviewFindings(report!.findings, undefined)).toEqual(
      report!.findings,
    );
  });

  it("起票済みのタイトルだけを除く", () => {
    const report = parseCodeReviewReport(REPORT);
    const createdFindingIssues = new Map([["未完了ジョブの判定が種別を見ていない", 2170]]);
    const remaining = filterUncreatedCodeReviewFindings(report!.findings, createdFindingIssues);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe("同じ絞り込みを2か所で組み立てている");
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

describe("summarizeCodeReviewComments", () => {
  it("結果が返っていれば重要度ごとの件数を返す", () => {
    const summary = summarizeCodeReviewComments([
      { body: codeReviewRequestCommentBody("") },
      { body: REPORT },
    ]);
    expect(summary.state).toBe("reported");
    expect(summary.counts).toEqual({ high: 1, medium: 0, low: 1 });
    expect(summary.findingCount).toBe(2);
    // 対応状況（#2868）を数えるのに使う。行には出さない
    expect(summary.findingTitles).toEqual([
      "未完了ジョブの判定が種別を見ていない",
      "同じ絞り込みを2か所で組み立てている",
    ]);
  });

  it("指摘が1件も無い結果は、件数0のreportedとして返す（＝一覧では「指摘なし」）", () => {
    const summary = summarizeCodeReviewComments([
      { body: codeReviewRequestCommentBody("") },
      { body: `${CODE_REVIEW_REPORT_MARKER}\n読んだコード: x\n\n直すべき点はありません。` },
    ]);
    expect(summary.state).toBe("reported");
    expect(summary.findingCount).toBe(0);
  });

  it("依頼だけで結果が返っていなければpending", () => {
    const summary = summarizeCodeReviewComments([{ body: codeReviewRequestCommentBody("観点") }]);
    expect(summary.state).toBe("pending");
    expect(summary.findingCount).toBe(0);
  });

  it("依頼も結果も無ければmissing", () => {
    expect(summarizeCodeReviewComments([]).state).toBe("missing");
    expect(summarizeCodeReviewComments([{ body: "ただのコメント" }]).state).toBe("missing");
  });

  it("何度もレビューした場合はいちばん新しい結果を見る（詳細パネルと同じ）", () => {
    const older = `${CODE_REVIEW_REPORT_MARKER}\n\n### [重大] 古い指摘\n\n本文`;
    const summary = summarizeCodeReviewComments([{ body: older }, { body: REPORT }]);
    expect(summary.counts).toEqual({ high: 1, medium: 0, low: 1 });
  });
});

describe("formatCodeReviewListCount", () => {
  const open = { state: "open" as const };
  const closed = { state: "closed" as const };

  it("close済みが混ざっていれば未完了の件数を添える", () => {
    expect(formatCodeReviewListCount([open, closed, closed], 3)).toBe("3件・未完了1件");
  });

  it("全部openなら添えるものが無いのでnull（呼び出し側が「N件」に落とす）", () => {
    expect(formatCodeReviewListCount([open, open], 2)).toBeNull();
  });

  it("全部close済みでも未完了は出さない", () => {
    expect(formatCodeReviewListCount([closed, closed], 2)).toBeNull();
  });

  it("保留中は他のビューと同じ形で添える", () => {
    expect(formatCodeReviewListCount([open, closed], 2, 1)).toBe("2件・未完了1件・保留中1件");
    expect(formatCodeReviewListCount([open], 1, 2)).toBe("1件・保留中2件");
  });
});

describe("summarizeCodeReviewFindingProgress", () => {
  const titles = ["指摘A", "指摘B", "指摘C"];
  const issue = (number: number, title: string, state: "open" | "closed") => ({
    repositoryFullName: "guchi-apps/issue-deck",
    title,
    number,
    state,
  });

  it("見出しと同じタイトルのIssueを起票済み、closeされていれば対応済みとして数える", () => {
    expect(
      summarizeCodeReviewFindingProgress({
        findingTitles: titles,
        issues: [issue(10, "指摘A", "closed"), issue(11, "指摘B", "open")],
        repositoryFullName: "guchi-apps/issue-deck",
      }),
    ).toEqual({ total: 3, created: 2, resolved: 1 });
  });

  it("別リポジトリの同名Issueは数えない（起票先はレビュー対象のリポジトリ）", () => {
    expect(
      summarizeCodeReviewFindingProgress({
        findingTitles: ["指摘A"],
        issues: [{ ...issue(10, "指摘A", "closed"), repositoryFullName: "guchi-apps/car-care" }],
        repositoryFullName: "guchi-apps/issue-deck",
      }),
    ).toEqual({ total: 1, created: 0, resolved: 0 });
  });

  it("同じタイトルが複数あれば先に立てた方（番号の小さい方）を見る", () => {
    expect(
      summarizeCodeReviewFindingProgress({
        findingTitles: ["指摘A"],
        issues: [issue(20, "指摘A", "open"), issue(10, "指摘A", "closed")],
        repositoryFullName: "guchi-apps/issue-deck",
      }),
    ).toEqual({ total: 1, created: 1, resolved: 1 });
  });

  it("指摘が無ければnull（一覧はチップを出さない）", () => {
    expect(
      summarizeCodeReviewFindingProgress({
        findingTitles: [],
        issues: [issue(10, "指摘A", "closed")],
        repositoryFullName: "guchi-apps/issue-deck",
      }),
    ).toBeNull();
  });
});

describe("describeCodeReviewFindingProgress", () => {
  it("0件の内訳は落として1行にする", () => {
    expect(describeCodeReviewFindingProgress({ total: 6, created: 4, resolved: 2 })).toBe(
      "指摘6件：対応済み2件・起票済み2件・未起票2件",
    );
    expect(describeCodeReviewFindingProgress({ total: 3, created: 0, resolved: 0 })).toBe(
      "指摘3件：未起票3件",
    );
    expect(describeCodeReviewFindingProgress({ total: 2, created: 2, resolved: 2 })).toBe(
      "指摘2件：対応済み2件",
    );
  });
});
