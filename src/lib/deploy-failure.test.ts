import { describe, expect, it } from "vitest";

import { buildDeployFailureFixIssueDraft, buildDeployRecoveryIssueSection, parseRunIdFromRunUrl } from "@/lib/deploy-failure";

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

describe("修正Issueの指示文とログからの判別（#5632）", () => {
  const base = {
    seriesMarker: "<!-- issue-deck-deploy-recovery-series:s1 -->",
    failedSha: "abc",
    failedRunUrl: "https://github.com/o/r/actions/runs/9",
    failedRunAttempt: 2,
    failedJobs: ["deploy"],
    runningSha: null,
    logExcerpt: null,
    causeMarkerPrefix: "issue-deck-deploy-recovery-cause:",
  };

  it("マイグレーションの失敗なら判別結果と、migration・migration_unsafeの扱いを書く", () => {
    const body = buildDeployRecoveryIssueSection({
      ...base,
      failureKind: {
        kind: "migration_failed_record",
        migrationName: "20261227120000_fix_tag_groups",
        failedQueryNumber: null,
        evidence: "Error: P3009",
      },
    });
    expect(body).toContain("ログからの判別");
    expect(body).toContain("`20261227120000_fix_tag_groups`");
    expect(body).toContain("<!-- issue-deck-deploy-recovery-cause:migration -->");
    expect(body).toContain("<!-- issue-deck-deploy-recovery-cause:migration_unsafe -->");
    expect(body).toContain("マイグレーションの失敗の扱い");
    expect(body).toContain("deploy/pre-migrate.sh");
  });

  it("マイグレーション以外の種類でも、判別結果を書く", () => {
    const body = buildDeployRecoveryIssueSection({
      ...base,
      failureKind: { kind: "build", migrationName: null, failedQueryNumber: null, evidence: "Failed to compile." },
    });
    expect(body).toContain("ビルドの失敗");
    expect(body).not.toContain("- マイグレーション: ");
    // 判別を外すこともあるため、扱いの節は常に出す
    expect(body).toContain("マイグレーションの失敗の扱い");
  });

  it("判別が無ければ判別の節を出さない", () => {
    expect(buildDeployRecoveryIssueSection(base)).not.toContain("ログからの判別");
  });
});
