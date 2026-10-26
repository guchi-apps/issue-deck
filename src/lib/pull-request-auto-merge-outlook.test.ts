import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import {
  SYSTEM_BRANCH_PREFIXES,
  deriveAutoMergeOutlook,
  isSystemBranch,
} from "@/lib/pull-request-auto-merge-outlook";
import { derivePrimaryState } from "@/lib/pull-request-primary-state";
import { requiresUserMerge } from "@/lib/pull-request-list";
import type { PullRequestSummary } from "@/types/pull-request";

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/aide#680",
    repositoryFullName: "guchi-apps/aide",
    repositoryPrivate: false,
    number: 680,
    title: "t",
    htmlUrl: "https://github.com/guchi-apps/aide/pull/680",
    authorLogin: "m-guchi",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-665",
    headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    kind: "issue",
    linkedIssueNumber: 665,
    linkedIssueNumbers: [665],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true,
    repairWorkflowAvailability: {},
    repairRun: null,
    reviewVerdict: null,
    releaseVerification: null,
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
    ...overrides,
  } as PullRequestSummary;
}

describe("deriveAutoMergeOutlook", () => {
  it("Auto-mergeが予約済みなら予約済み", () => {
    expect(deriveAutoMergeOutlook(pr({ autoMergeEnabled: true }))?.kind).toBe("scheduled");
  });

  it("判定中は予定", () => {
    const outlook = deriveAutoMergeOutlook(
      pr({ mergeJudgement: { state: "pending", step: "claude-review", runUrl: null, aiReview: AI_REVIEW_NONE } }),
    );
    expect(outlook?.kind).toBe("expected");
  });

  it("開いた直後で判定が始まる前（CI実行中）は予定", () => {
    const outlook = deriveAutoMergeOutlook(
      pr({ ciState: "pending", mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE } }),
    );
    expect(outlook?.kind).toBe("expected");
  });

  it("判定が終わったのに予約されていなければ、されません", () => {
    const outlook = deriveAutoMergeOutlook(pr());
    expect(outlook?.kind).toBe("manual");
    expect(outlook?.reason).toContain("判定ログ");
  });

  it("レビュー担当の決定が失敗したら、その理由で、されません（yoteiflow#1337）", () => {
    const outlook = deriveAutoMergeOutlook(
      pr({
        mergeJudgement: {
          state: "settled",
          step: null,
          runUrl: null,
          aiReview: AI_REVIEW_NONE,
          failedJobs: ["review-provider"],
        },
      }),
    );
    expect(outlook?.kind).toBe("manual");
    expect(outlook?.reason).toContain("レビュー担当");
  });

  it("対応Issueに00.check-userが付いていれば、その理由で、されません", () => {
    const outlook = deriveAutoMergeOutlook(pr({ linkedIssueCheckUser: true, linkedIssueCheckReason: "merge" }));
    expect(outlook?.kind).toBe("manual");
    expect(outlook?.reason).toContain("マージ前の確認待ち");
  });

  it("判定の記録が無ければ、されません", () => {
    const outlook = deriveAutoMergeOutlook(
      pr({ mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE } }),
    );
    expect(outlook?.kind).toBe("manual");
  });

  it("システムブランチ・バージョンバンプは対象外", () => {
    expect(deriveAutoMergeOutlook(pr({ kind: "other", headRef: "release-sync/main-7752f9d3", linkedIssueNumber: null }))?.kind).toBe(
      "excluded",
    );
    expect(deriveAutoMergeOutlook(pr({ kind: "version-bump", headRef: "release/v8.76.0" }))?.kind).toBe("excluded");
  });

  it("リリースPRは人がマージする", () => {
    expect(deriveAutoMergeOutlook(pr({ kind: "release", baseRef: "main", headRef: "develop" }))?.kind).toBe("manual");
  });

  it("closed・draft・develop以外へのPRは出さない", () => {
    expect(deriveAutoMergeOutlook(pr({ state: "closed" }))).toBeNull();
    expect(deriveAutoMergeOutlook(pr({ draft: true }))).toBeNull();
    expect(deriveAutoMergeOutlook(pr({ baseRef: "main", kind: "other" }))).toBeNull();
  });
});

describe("derivePrimaryState と自動マージの見込み", () => {
  it("自動マージされないPRは「マージ可能」ではなく「手動マージ待ち」", () => {
    const primary = derivePrimaryState(pr());
    expect(primary.label).toBe("手動マージ待ち");
    expect(primary.tone).toBe("warn");
    expect(primary.needsAction).toBe(true);
  });

  it("予約済みなら従来どおりマージ可能", () => {
    expect(derivePrimaryState(pr({ autoMergeEnabled: true })).label).toBe("マージ可能");
  });

  it("対象外（リリース同期）は従来どおりマージ可能", () => {
    expect(derivePrimaryState(pr({ kind: "other", headRef: "release-sync/main-1", linkedIssueNumber: null })).label).toBe(
      "マージ可能",
    );
  });
});

describe("本番公開後のdevelop同期PR（#5081）", () => {
  const sync = (developSyncAutoMerge: { status: "auto" | "held"; reason: string } | null) =>
    pr({ kind: "other", headRef: "release-sync/main-1", linkedIssueNumber: null, developSyncAutoMerge });

  it("巡回が自動でマージする判定なら「自動マージ待ち」で、人のマージ待ちに数えない", () => {
    const pullRequest = sync({ status: "auto", reason: "自動レビューの判定を待っています" });
    expect(deriveAutoMergeOutlook(pullRequest)?.kind).toBe("expected");
    const primary = derivePrimaryState(pullRequest);
    expect(primary.label).toBe("自動マージ待ち");
    expect(primary.needsAction).toBe(false);
    expect(requiresUserMerge(pullRequest)).toBe(false);
  });

  it("人の対応が要る停止は「手動マージ待ち」で理由を出し、ユーザーのマージ待ちに数える", () => {
    const pullRequest = sync({ status: "held", reason: "人の確認ラベル（00.check-user）が付いています" });
    expect(deriveAutoMergeOutlook(pullRequest)?.kind).toBe("manual");
    const primary = derivePrimaryState(pullRequest);
    expect(primary.label).toBe("手動マージ待ち");
    expect(primary.reason).toContain("00.check-user");
    expect(primary.needsAction).toBe(true);
    expect(requiresUserMerge(pullRequest)).toBe(true);
  });

  it("巡回の判定が無ければ従来どおり対象外", () => {
    expect(deriveAutoMergeOutlook(sync(null))?.kind).toBe("excluded");
  });
});

describe("SYSTEM_BRANCH_PREFIXES", () => {
  it("ワークフローのSYSTEM_BRANCH_PATTERNと一致する", () => {
    const yaml = readFileSync(
      path.join(process.cwd(), ".github/workflows/reusable-claude-review-develop.yml"),
      "utf8",
    );
    const patterns = [...yaml.matchAll(/SYSTEM_BRANCH_PATTERN='\^\(([^)]*)\)\/'/g)].map((m) => m[1]);
    expect(patterns.length).toBeGreaterThanOrEqual(2);
    for (const pattern of patterns) {
      expect(pattern.split("|")).toEqual([...SYSTEM_BRANCH_PREFIXES]);
    }
  });

  it("接頭辞の後ろに/が要る", () => {
    expect(isSystemBranch("release-sync/main-1")).toBe(true);
    expect(isSystemBranch("releases-note")).toBe(false);
    expect(isSystemBranch("issue-12")).toBe(false);
    expect(isSystemBranch("cleanup/zaim-write-secret-row")).toBe(false);
  });
});
