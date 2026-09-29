import { describe, expect, it } from "vitest";

import type { ReviewGateRepository } from "@/lib/github/review-gates";
import { buildReviewGateIssueDraft } from "@/lib/review-gate-issue-draft";

function repository(overrides: Partial<ReviewGateRepository> = {}): ReviewGateRepository {
  return {
    fullName: "guchi-apps/sample",
    callerUrl: "https://github.com/guchi-apps/sample/blob/main/.github/workflows/claude-review-develop.yml",
    config: {
      inputs: {
        "review-file-threshold": { value: "10", explicit: false },
        "review-line-threshold": { value: "500", explicit: false },
        "merge-policy": { value: "relaxed", explicit: false },
        "dependency-check": { value: "major", explicit: false },
        "lock-files": { value: "pnpm-lock.yaml", explicit: false },
      },
      riskPaths: [],
      riskPathsState: "template",
      customRiskPathCount: 0,
      missingTemplateRiskPathCount: 0,
    },
    outcomes: [
      { number: 1, outcome: "reviewed" },
      { number: 2, outcome: "skipped" },
      { number: 3, outcome: "skipped" },
    ],
    outcomesAvailable: true,
    ...overrides,
  } as ReviewGateRepository;
}

describe("buildReviewGateIssueDraft", () => {
  it("対象リポジトリと現在の条件・実行状況を下書きへ入れる", () => {
    const draft = buildReviewGateIssueDraft(repository());
    expect(draft.repositoryFullName).toBe("guchi-apps/sample");
    expect(draft.body).toContain("10ファイル / 500行");
    expect(draft.body).toContain("risk-paths: 雛形のまま");
    expect(draft.body).toContain("レビュー実行1件 / skip2件");
    expect(draft.body).toContain("## 変更したい内容");
  });

  it("実行状況を取得できなかったときはその旨を書く", () => {
    const draft = buildReviewGateIssueDraft(repository({ outcomesAvailable: false }));
    expect(draft.body).toContain("取得できませんでした");
  });
});
