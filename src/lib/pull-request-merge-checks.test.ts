import { describe, expect, it } from "vitest";

import {
  buildMergeChecks,
  ciCell,
  cellsFromReleaseChange,
  cellsFromSummary,
  type MergeCheckItem,
} from "@/lib/pull-request-merge-checks";
import { buildReleaseCheckCells, type ReleaseCandidate } from "@/lib/release-candidate-checks";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import type { PullRequestSummary, ReleaseChangePullRequest } from "@/types/pull-request";

const section = (kind: "integration" | "ai_review", state: string) =>
  ({
    kind,
    state,
    reason: null,
    summary: null,
    evidenceUrl: null,
    agent: null,
    updatedAt: null,
    findings: [],
    affectedPullRequests: [],
    affectedFiles: [],
    reviewedFiles: null,
    totalFiles: null,
    progress: null,
    diagnostic: null,
  }) as never;

const verification = (overrides: Partial<ReleaseVerificationSummary> = {}): ReleaseVerificationSummary => ({
  enforced: false,
  gateStatus: "blocked",
  blockers: [],
  integration: section("integration", "passed"),
  aiReview: section("ai_review", "needs_check"),
  mac: { state: "passed", reason: null, summary: null, evidenceUrl: null, updatedAt: null },
  aiReviewAssignee: "x",
  target: { baseSha: "b".repeat(40), headSha: "h".repeat(40) },
  ...overrides,
});

const candidate = (number: number, prs: number[], v = verification()): ReleaseCandidate => ({
  number,
  title: `v${number}`,
  headRef: `release-main/v1.0.${number}`,
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  pullRequestNumbers: prs,
  verification: v,
});

const cells = (candidates: ReleaseCandidate[], prNumber = 10, selectedNumber: number | null = null) =>
  buildReleaseCheckCells({ source: { status: "loaded", candidates }, pullRequestNumber: prNumber, selectedNumber, nowMs: 0 });

const changePr = (overrides: Partial<ReleaseChangePullRequest> = {}): ReleaseChangePullRequest => ({
  number: 10,
  title: "t",
  issueNumber: 5,
  isVersionBump: false,
  review: { reviewKind: "ok", reviewLabel: "問題なし", reviewedSha: "aaa" } as never,
  prHeadSha: "aaa",
  reviewUnavailable: false,
  mergeChecks: { ci: { state: "success" } },
  ...overrides,
});

const build = (pr: ReleaseChangePullRequest | null, release = cells([candidate(20, [10])])): MergeCheckItem[] =>
  buildMergeChecks({
    ...cellsFromReleaseChange(pr, "候補のCIは成功"),
    conflict: { mark: "●", state: "なし", tone: "ok", reason: null, target: "候補", evidence: null },
    release,
  });
const item = (items: MergeCheckItem[], key: string) => items.find((i) => i.key === key)!;

describe("buildMergeChecks（6項目）", () => {
  it("6項目を固定の順序で返し、計画レビューを含めない", () => {
    const items = build(changePr());
    expect(items.map((i) => i.key)).toEqual(["ci", "code", "conflict", "all", "integration", "mac"]);
    expect(items.filter((i) => i.common).map((i) => i.key)).toEqual(["all", "integration", "mac"]);
    expect(items.some((i) => (i.key as string) === "plan")).toBe(false);
  });

  it("成功と要修正が混在しても項目ごとの状態を保つ", () => {
    const items = build(
      changePr({
        review: { reviewKind: "changes-requested", reviewLabel: "要修正", reviewedSha: "aaa" } as never,
        mergeChecks: { ci: { state: "failure" } },
      }),
    );
    expect(item(items, "ci").tone).toBe("bad");
    expect(item(items, "code").state).toBe("要修正");
    expect(item(items, "conflict").tone).toBe("ok");
    expect(item(items, "integration").state).toBe("問題なし");
  });

  it("追加取得が無い・失敗は取得不可で、成功と推測しない", () => {
    expect(item(build(changePr({ mergeChecks: undefined })), "ci")).toMatchObject({ state: "取得不可", tone: "warn" });
    expect(item(build(null), "code").state).toBe("取得不可");
  });

  it("コードレビューの省略・記録なし・取得不可・古い結果を区別する", () => {
    const code = (p: ReleaseChangePullRequest | null) => item(build(p), "code");
    expect(code(changePr({ review: { reviewKind: "skipped", reviewLabel: "", reviewedSha: "aaa" } as never })).state).toBe("省略");
    expect(code(changePr({ review: null })).state).toBe("未実施");
    expect(code(changePr({ reviewUnavailable: true })).state).toBe("取得不可");
    expect(code(changePr({ prHeadSha: "bbb" }))).toMatchObject({ state: "無効", tone: "warn" });
  });

  it("CIは個別PRの結果で、リリース候補のCIと混ぜない", () => {
    const ci = item(build(changePr({ mergeChecks: { ci: { state: "none" } } })), "ci");
    expect(ci.state).toBe("未実施");
    expect(ci.target).toContain("個別PR");
    expect(ci.reason).toContain("候補");
  });
});

describe("リリース候補の共通結果", () => {
  it("Mac検証は統合検証とは独立した状態を持つ（集約から推測しない）", () => {
    const macStates = ["passed", "failed", "running", "not_applicable", "needs_setup", "not_recorded", "invalidated"] as const;
    const expected = ["成功", "失敗", "実行中", "対象外", "設定不足", "未実施", "古い結果"];
    macStates.forEach((state, index) => {
      const c = cells([candidate(20, [10], verification({ mac: { state, reason: null, summary: null, evidenceUrl: null, updatedAt: null } }))]);
      expect(c.mac.state).toBe(expected[index]);
      expect(c.integration.state).toBe("問題なし");
    });
  });

  it("候補が無ければ「リリース未作成」の理由付き未実施で、他の候補の結果を転用しない", () => {
    const c = cells([candidate(20, [99])]);
    expect(c.candidate).toBeNull();
    for (const cell of [c.all, c.integration, c.mac]) {
      expect(cell).toMatchObject({ state: "リリース未作成", tone: "muted" });
      expect(cell.reason).toContain("候補");
    }
  });

  it("複数候補に含まれるときは新しい候補を既定にし、選択で切り替えられる", () => {
    const old = candidate(18, [10], verification({ integration: section("integration", "failed") }));
    const latest = candidate(20, [10]);
    const c = cells([old, latest]);
    expect(c.candidate?.number).toBe(20);
    expect(c.choices.map((x) => x.number)).toEqual([20, 18]);
    expect(c.integration.state).toBe("問題なし");
    expect(cells([old, latest], 10, 18).integration.state).toBe("失敗");
  });

  it("取得失敗は取得不可で、成功と扱わない", () => {
    const c = buildReleaseCheckCells({ source: { status: "error", message: "失敗" }, pullRequestNumber: 10, nowMs: 0 });
    expect(c.all).toMatchObject({ state: "取得不可", tone: "warn" });
    expect(c.mac.state).toBe("取得不可");
  });

  it("共通項目の判定対象に候補PRとSHAを含め、証跡は候補へ向く", () => {
    const all = item(build(changePr()), "all");
    expect(all.target).toContain("候補PR #20");
    expect(all.target).toContain("hhhhhhh");
    expect(all.evidence).toMatchObject({ kind: "candidate" });
    expect(all.candidateNumber).toBe(20);
  });
});

describe("PRの概要（PR詳細・一覧・ブランチ）から作るセル", () => {
  const summary = (overrides: Record<string, unknown> = {}) =>
    ({
      number: 10,
      state: "open",
      merged: false,
      draft: false,
      ciState: "success",
      mergeable: true,
      headSha: "aaa",
      reviewVerdict: null,
      mergeJudgement: { aiReview: { state: "passed" } },
      ...overrides,
    }) as unknown as PullRequestSummary;

  it("コンフリクトの有無・確認中を区別する", () => {
    expect(cellsFromSummary(summary()).conflict.state).toBe("なし");
    expect(cellsFromSummary(summary({ mergeable: false })).conflict).toMatchObject({ state: "あり", tone: "bad" });
    expect(cellsFromSummary(summary({ mergeable: null })).conflict).toMatchObject({ state: "確認中", tone: "warn" });
  });

  it("クローズ済みは対象外、CIの失敗・実行中・不明を区別する", () => {
    expect(cellsFromSummary(summary({ merged: true })).ci.state).toBe("対象外");
    expect(cellsFromSummary(summary({ ciState: "failure" })).ci.state).toBe("失敗");
    expect(cellsFromSummary(summary({ ciState: "pending" })).ci.state).toBe("実行中");
    expect(cellsFromSummary(summary({ ciState: "unknown" })).ci.state).toBe("取得不可");
  });

  it("レビュー実行中・省略・記録なしを区別し、headが進んだ判定は無効にする", () => {
    expect(cellsFromSummary(summary({ mergeJudgement: { aiReview: { state: "pending" } } })).code.state).toBe("実行中");
    expect(cellsFromSummary(summary({ mergeJudgement: { aiReview: { state: "none" } } })).code.state).toBe("未実施");
    const stale = cellsFromSummary(
      summary({ reviewVerdict: { reviewKind: "ok", reviewLabel: "", reviewedSha: "old" }, headSha: "new" }),
    );
    expect(stale.code).toMatchObject({ state: "無効", tone: "warn" });
  });

  it("ciCellのnoneは成功扱いにしない", () => {
    expect(ciCell("none")).toMatchObject({ state: "未実施", tone: "muted" });
  });
});
