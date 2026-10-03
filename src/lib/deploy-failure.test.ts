import { describe, expect, it } from "vitest";

import { buildDeployFailureFixIssueDraft, parseRunIdFromRunUrl } from "@/lib/deploy-failure";

describe("修正Issueの下書き（#3887）", () => {
  it("run URLからrun idを読む", () => {
    expect(parseRunIdFromRunUrl("https://github.com/o/r/actions/runs/123/attempts/2")).toBe(123);
    expect(parseRunIdFromRunUrl(null)).toBeNull();
  });

  it("分析があれば推定原因とログ抜粋を本文へ入れる", () => {
    const draft = buildDeployFailureFixIssueDraft({
      repositoryFullName: "o/r",
      version: "1.2.3",
      runUrl: "https://github.com/o/r/actions/runs/9",
      failedJobs: ["deploy"],
      analysis: { cause: "列が重複", excerpt: "Duplicate column", advice: null },
    });
    expect(draft.title).toBe("[デプロイ失敗の修正] v1.2.3の本番デプロイが失敗する原因を直す");
    expect(draft.body).toContain("列が重複");
    expect(draft.body).toContain("Duplicate column");
  });

  it("分析が無ければ実行へのリンクだけの下書きになる", () => {
    const draft = buildDeployFailureFixIssueDraft({
      repositoryFullName: "o/r",
      version: null,
      runUrl: null,
      failedJobs: [],
      analysis: null,
    });
    expect(draft.body).not.toContain("AIによる原因の推定");
  });
});
