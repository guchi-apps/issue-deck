import { describe, expect, it } from "vitest";

import {
  buildMergePrecheck,
  type MergePrecheckReviews,
  type MergePrecheckSource,
} from "@/lib/pull-request-merge-precheck";
import type { PullRequestChangeReview } from "@/lib/pull-request-changes";

function source(overrides: Partial<MergePrecheckSource> = {}): MergePrecheckSource {
  return { ciState: "success", ciChecks: [], mergeable: true, repairRun: null, ...overrides };
}

function review(
  overrides: Partial<PullRequestChangeReview> & Pick<PullRequestChangeReview, "reviewKind">,
): PullRequestChangeReview {
  return {
    id: `c${overrides.pullRequestNumber ?? 1}`,
    pullRequestNumber: 1,
    issueNumber: null,
    title: "変更",
    kind: "issue",
    reviewLabel: "",
    ...overrides,
  };
}

function loaded(...reviewed: PullRequestChangeReview[]): MergePrecheckReviews {
  return { status: "loaded", reviewed };
}

const row = (precheck: ReturnType<typeof buildMergePrecheck>, id: string) =>
  precheck.rows.find((r) => r.id === id)!;

describe("buildMergePrecheck", () => {
  it("CIは成功=ok・実行中/不明=warn・失敗=bad", () => {
    const reviews = loaded(review({ reviewKind: "ok" }));
    expect(row(buildMergePrecheck(source(), reviews), "ci").level).toBe("ok");
    expect(row(buildMergePrecheck(source({ ciState: "pending" }), reviews), "ci").level).toBe("warn");
    expect(row(buildMergePrecheck(source({ ciState: "unknown" }), reviews), "ci").level).toBe("warn");
    expect(row(buildMergePrecheck(source({ ciState: "failure" }), reviews), "ci").level).toBe("bad");
  });

  it("CIが失敗したときは失敗したチェック名と自動修正の実行中を補足に出す", () => {
    const precheck = buildMergePrecheck(
      source({
        ciState: "failure",
        ciChecks: [
          { name: "version-tag-check", status: "completed", conclusion: "failure", startedAt: null, completedAt: null, htmlUrl: null, runId: null },
          { name: "build", status: "completed", conclusion: "success", startedAt: null, completedAt: null, htmlUrl: null, runId: null },
        ],
        repairRun: { kind: "ci", startedAt: "2026-09-19T00:00:00.000Z", runUrl: null },
      }),
      loaded(review({ reviewKind: "ok" })),
    );
    expect(row(precheck, "ci").detail).toBe("version-tag-checkが失敗しています。自動修正を実行中です");
  });

  it("コンフリクトはnull（判定中）を「なし」として扱わない", () => {
    const reviews = loaded(review({ reviewKind: "ok" }));
    expect(row(buildMergePrecheck(source({ mergeable: true }), reviews), "conflict").level).toBe("ok");
    expect(row(buildMergePrecheck(source({ mergeable: null }), reviews), "conflict").level).toBe("warn");
    const conflicted = buildMergePrecheck(
      source({
        mergeable: false,
        repairRun: { kind: "conflict", startedAt: "2026-09-19T00:00:00.000Z", runUrl: null },
      }),
      reviews,
    );
    expect(row(conflicted, "conflict").level).toBe("bad");
    expect(row(conflicted, "conflict").detail).toBe("自動解消を実行中です");
  });

  it("レビューは要修正=bad・要確認/記録なし=warn・それ以外=ok で、該当PRを補足に出す", () => {
    const bad = row(
      buildMergePrecheck(
        source(),
        loaded(
          review({ pullRequestNumber: 307, reviewKind: "changes-requested" }),
          review({ pullRequestNumber: 309, reviewKind: "unknown" }),
          review({ pullRequestNumber: 305, reviewKind: "ok" }),
        ),
      ),
      "review",
    );
    expect(bad.level).toBe("bad");
    expect(bad.summary).toBe("要修正 1 ／ 問題なし 1 ／ 記録なし 1");
    expect(bad.detail).toBe("#307が要修正、#309は判定の記録がありません");

    const warn = row(
      buildMergePrecheck(
        source(),
        loaded(
          review({ pullRequestNumber: 305, reviewKind: "needs-check" }),
          review({ pullRequestNumber: 304, reviewKind: "ok" }),
        ),
      ),
      "review",
    );
    expect(warn.level).toBe("warn");

    const ok = row(
      buildMergePrecheck(
        source(),
        loaded(
          review({ reviewKind: "ok" }),
          review({ pullRequestNumber: 311, reviewKind: "skipped" }),
        ),
      ),
      "review",
    );
    expect(ok.level).toBe("ok");
    expect(ok.summary).toBe("問題なし 1 ／ 実施なし 1");
  });

  it("バンプPRはレビューの対象に数えず、補足にも出さない", () => {
    const precheck = buildMergePrecheck(
      source(),
      loaded(
        review({ pullRequestNumber: 305, reviewKind: "ok" }),
        review({ pullRequestNumber: 298, kind: "version-bump", reviewKind: "skipped" }),
      ),
    );
    expect(row(precheck, "review").summary).toBe("問題なし 1");
  });

  it("補足のPR番号は3件までで、超えた分は「ほかN件」にまとめる", () => {
    const precheck = buildMergePrecheck(
      source(),
      loaded(
        ...[1, 2, 3, 4, 5].map((n) => review({ pullRequestNumber: n, reviewKind: "needs-check" })),
        review({ pullRequestNumber: 9, reviewKind: "ok" }),
      ),
    );
    expect(row(precheck, "review").detail).toBe("#1・#2・#3ほか2件が要確認");
  });

  it("判定が1件も無いリリースは▲にせず、総合判定の件数にも数えない", () => {
    const precheck = buildMergePrecheck(
      source(),
      loaded(review({ reviewKind: "unknown" }), review({ pullRequestNumber: 2, reviewKind: "unknown" })),
    );
    expect(row(precheck, "review").level).toBe("neutral");
    expect(row(precheck, "review").summary).toBe("自動レビューの記録がありません");
    expect(precheck.overall).toBe("ok");
    expect(precheck.headline).toBe("確認できた2項目に問題はありません");
  });

  it("変更点を取得できなかったときはレビューの行を灰色にし、マージを止める材料にしない", () => {
    const precheck = buildMergePrecheck(source(), { status: "error" });
    expect(row(precheck, "review").level).toBe("neutral");
    expect(precheck.overall).toBe("ok");
  });

  it("取得中は「すべて問題ありません」と言い切らない", () => {
    const precheck = buildMergePrecheck(source(), { status: "loading" });
    expect(precheck.overall).toBe("pending");
    // 取得中でもCI・コンフリクトの問題は先に出す
    expect(buildMergePrecheck(source({ ciState: "failure" }), { status: "loading" }).overall).toBe("bad");
  });

  it("総合判定はbadを優先し、件数はそのレベルの行の数", () => {
    const allOk = buildMergePrecheck(source(), loaded(review({ reviewKind: "ok" })));
    expect(allOk.overall).toBe("ok");
    expect(allOk.headline).toBe("3項目すべて問題ありません");

    const warn = buildMergePrecheck(source({ ciState: "pending" }), loaded(review({ reviewKind: "needs-check" })));
    expect(warn.overall).toBe("warn");
    expect(warn.headline).toBe("確認が必要な項目があります（2件）");

    const bad = buildMergePrecheck(
      source({ ciState: "failure", mergeable: null }),
      loaded(review({ reviewKind: "ok" })),
    );
    expect(bad.overall).toBe("bad");
    expect(bad.headline).toBe("止めるべき項目があります（1件）");
  });
});
