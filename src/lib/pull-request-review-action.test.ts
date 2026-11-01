import { describe, expect, it } from "vitest";

import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";
import { derivePrimaryState } from "@/lib/pull-request-primary-state";
import {
  applyReviewAction,
  deriveReviewAction,
  summarizeReviewConcerns,
} from "@/lib/pull-request-review-action";
import type { PullRequestReviewResponseContext, PullRequestSummary } from "@/types/pull-request";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const OLD_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/issue-deck#4459",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 4459,
    title: "t",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/4459",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-4421",
    headSha: SHA,
    kind: "issue",
    linkedIssueNumber: 4421,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: true,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true,
    repairWorkflowAvailability: {},
    repairRun: null,
    reviewVerdict: verdict("needs-check"),
    releaseVerification: null,
    createdAt: "2026-10-12T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
    ...overrides,
  } as PullRequestSummary;
}

function verdict(reviewKind: string, reviewedSha: string | null = SHA) {
  return { reviewKind, reviewedSha, reviewLabel: "" } as unknown as PullRequestSummary["reviewVerdict"];
}

const REVIEW_BODY = [
  "## 総評",
  "全体として良い変更です。",
  "## 気になった点",
  "1. **Issue #4421 の完了条件**「準備失敗時の再試行」が実装に見当たりません",
  "2. 準備中の判定が `ポーリング間隔` に依存しています",
  "- [詳細](https://example.com) を確認してください",
  "- 4件目は上部に出さない",
].join("\n");

function review(overrides: Partial<PullRequestReviewCommentContent> = {}): PullRequestReviewCommentContent {
  return {
    verdictKind: "needs-check",
    verdictLabel: "要確認",
    body: REVIEW_BODY,
    createdAt: "2026-10-12T01:00:00Z",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/4459#issuecomment-1",
    reviewedSha: SHA,
    isStale: false,
    ...overrides,
  };
}

const context = (overrides: Partial<PullRequestReviewResponseContext> = {}): PullRequestReviewResponseContext => ({
  issueNumber: 4421,
  linkedIssueLocal: false,
  currentFixRequest: null,
  fetchFailed: false,
  ...overrides,
});

describe("summarizeReviewConcerns", () => {
  it("「気になった点」以降の箇条書きを、装飾を落として最大3件まで拾う", () => {
    expect(summarizeReviewConcerns(REVIEW_BODY)).toEqual([
      "Issue #4421 の完了条件「準備失敗時の再試行」が実装に見当たりません",
      "準備中の判定が ポーリング間隔 に依存しています",
      "詳細 を確認してください",
    ]);
  });

  it("箇条書きが無ければ空（本文は指摘タブで読む）", () => {
    expect(summarizeReviewConcerns("問題はありません。")).toEqual([]);
  });
});

describe("deriveReviewAction", () => {
  it("#4459相当（CI成功・競合なし・最新HEADのneeds-check）は、対応を選ばせる", () => {
    const action = deriveReviewAction({ pullRequest: pr(), review: review(), context: context() });
    expect(action).toMatchObject({
      kind: "respond",
      verdict: "needs-check",
      bodyAvailable: true,
      autoRepair: false,
      request: { available: false, alternative: "open-issue" },
    });
    if (action.kind !== "respond") throw new Error("unreachable");
    expect(action.concerns).toHaveLength(3);
  });

  it("対応済みの記録があれば、未対応扱いをやめて acknowledged を返す（#5159）", () => {
    const action = deriveReviewAction({
      pullRequest: pr(),
      review: review(),
      context: context(),
      acknowledgement: { sha: "abc", recordedBy: "guchi" },
    });
    expect(action).toEqual({ kind: "acknowledged", verdict: "needs-check", recordedBy: "guchi" });
  });

  it("要修正で自動修正ワークフローがあれば、既存の自動修正を主操作にできる", () => {
    const action = deriveReviewAction({
      pullRequest: pr({ reviewVerdict: verdict("changes-requested") }),
      review: review({ verdictKind: "changes-requested" }),
      context: context(),
    });
    expect(action).toMatchObject({ kind: "respond", autoRepair: true, autoRepairUnavailable: null });
  });

  it("要修正でもワークフローが未配布なら、理由を出し、廃止済みの依頼へはフォールバックしない", () => {
    const action = deriveReviewAction({
      pullRequest: pr({ reviewVerdict: verdict("changes-requested"), repairWorkflowAvailability: { review: "missing" } }),
      review: review(),
      context: context(),
    });
    expect(action).toMatchObject({ kind: "respond", autoRepair: false, request: { available: false, alternative: "open-issue" } });
    if (action.kind !== "respond") throw new Error("unreachable");
    expect(action.autoRepairUnavailable).toContain("未配布");
  });

  it("修正中・依頼済み・古いHEADでは、対応を選ばせない", () => {
    expect(
      deriveReviewAction({
        pullRequest: pr({ repairRun: { kind: "review" } as PullRequestSummary["repairRun"] }),
        review: review(),
        context: context(),
      }).kind,
    ).toBe("repairing");
    expect(
      deriveReviewAction({
        pullRequest: pr(),
        review: review(),
        context: context({ currentFixRequest: { commentUrl: "https://x", createdAt: "2026-10-12T02:00:00Z" } }),
      }),
    ).toMatchObject({ kind: "requested", commentUrl: "https://x" });
    expect(
      deriveReviewAction({ pullRequest: pr({ reviewVerdict: verdict("needs-check", OLD_SHA) }), review: review(), context: context() }),
    ).toMatchObject({ kind: "stale", reviewedSha: OLD_SHA });
  });

  it("本文の取得前・取得失敗では、要点を出さずに本文が無いことを返す", () => {
    const action = deriveReviewAction({ pullRequest: pr(), review: null, context: undefined });
    expect(action).toMatchObject({ kind: "respond", bodyAvailable: false, concerns: [] });
    const lookupFailed = deriveReviewAction({ pullRequest: pr(), review: review(), context: context({ fetchFailed: true }) });
    expect(lookupFailed).toMatchObject({ kind: "respond", requestLookupFailed: true });
  });

  it("依頼を渡すIssueが無い・ローカル対応中は、理由と代わりの操作を返す", () => {
    expect(
      deriveReviewAction({ pullRequest: pr({ headRef: "chore/foo" }), review: review(), context: null }),
    ).toMatchObject({ kind: "respond", request: { available: false, alternative: "draft-fix-issue" } });
    expect(
      deriveReviewAction({ pullRequest: pr(), review: review(), context: context({ linkedIssueLocal: true }) }),
    ).toMatchObject({ kind: "respond", request: { available: false, alternative: "open-issue" } });
    // 生きているセッションが無い11.localは外し忘れとして外す案内を出す（#5160）
    const leftover = deriveReviewAction({
      pullRequest: pr(),
      review: review(),
      context: context({ linkedIssueLocal: true, linkedIssueSessionAlive: false }),
    });
    expect(leftover).toMatchObject({ kind: "respond", request: { available: false, alternative: "open-issue" } });
    if (leftover.kind !== "respond") throw new Error("unreachable");
    expect(leftover.request.reason).toContain("11.localを外し");
    expect(leftover.request.reason).not.toContain("実行されません");
    // セッションが動いている・確かめられなかったときは「対応中」の案内のまま
    for (const linkedIssueSessionAlive of [true, null, undefined]) {
      const active = deriveReviewAction({
        pullRequest: pr(),
        review: review(),
        context: context({ linkedIssueLocal: true, linkedIssueSessionAlive }),
      });
      if (active.kind !== "respond") throw new Error("unreachable");
      expect(active.request.reason).toContain("対応中");
      expect(active.request.reason).not.toContain("11.localを外し");
    }
    // closedのIssueへの@claudeはdispatchがskipする（計画レビューの指摘）
    expect(
      deriveReviewAction({ pullRequest: pr(), review: review(), context: context({ linkedIssueClosed: true }) }),
    ).toMatchObject({ kind: "respond", request: { available: false, alternative: "draft-fix-issue" } });
  });

  it("LGTM・閉じたPR・ドラフトは対象外", () => {
    expect(deriveReviewAction({ pullRequest: pr({ reviewVerdict: verdict("lgtm") }), review: null, context: null }).kind).toBe("none");
    expect(deriveReviewAction({ pullRequest: pr({ state: "closed" }), review: null, context: null }).kind).toBe("none");
    expect(deriveReviewAction({ pullRequest: pr({ draft: true }), review: null, context: null }).kind).toBe("none");
  });
});

describe("applyReviewAction", () => {
  it("依頼済みは「修正を依頼済み（操作不要）」にし、解消済みにはしない", () => {
    const pullRequest = pr();
    const requested = applyReviewAction(derivePrimaryState(pullRequest), {
      kind: "requested",
      verdict: "needs-check",
      commentUrl: null,
      createdAt: "",
    });
    expect(requested).toMatchObject({ kind: "review-findings", label: "修正を依頼済み", tone: "run", needsAction: false });
  });

  it("対応済みの記録は代表状態を「記録済み（操作不要）」にする（#5159）", () => {
    const pullRequest = pr();
    const acknowledged = applyReviewAction(derivePrimaryState(pullRequest), {
      kind: "acknowledged",
      verdict: "needs-check",
      recordedBy: "guchi",
    });
    expect(acknowledged).toMatchObject({ kind: "review-findings", tone: "ok", needsAction: false, repairKinds: [] });
  });

  it("対応待ちのときは代表状態を変えない", () => {
    const pullRequest = pr();
    const primary = derivePrimaryState(pullRequest);
    const action = deriveReviewAction({ pullRequest, review: review(), context: context() });
    expect(applyReviewAction(primary, action)).toBe(primary);
    expect(primary).toMatchObject({ kind: "review-findings", label: "レビュー要確認", needsAction: true });
  });
});
