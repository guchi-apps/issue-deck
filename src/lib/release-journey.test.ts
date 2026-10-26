import { describe, expect, it } from "vitest";

import { MERGE_JUDGEMENT_UNKNOWN } from "@/lib/github/check-rollup";
import { isReleaseJourneyNeedingUser, resolveReleaseJourney, type ReleaseJourney } from "@/lib/release-journey";
import type { BranchFlowDeployState } from "@/types/branch-flow";
import type { PullRequestReleaseChecks, PullRequestSummary, ReleaseRcFacts } from "@/types/pull-request";

type Input = Parameters<typeof resolveReleaseJourney>[0];
type JourneyPullRequest = NonNullable<Input["bumpPullRequest"]>;

const PASSED: PullRequestReleaseChecks = {
  aiReview: "passed",
  integration: "passed",
  enforced: true,
  started: { aiReview: false, integration: false, mac: false },
  integrationSetupGap: null,
};

function pr(overrides: Partial<PullRequestSummary> = {}): JourneyPullRequest {
  return {
    state: "open",
    merged: false,
    baseRef: "develop",
    headRef: "release-bump/v1",
    ciState: "success",
    ciChecks: [],
    mergeJudgement: MERGE_JUDGEMENT_UNKNOWN,
    releaseChecks: null,
    iosPrecheck: null,
    ...overrides,
  } as JourneyPullRequest;
}

/** 旧方式の候補（`release-main/v*`） */
function legacyCandidate(overrides: Partial<PullRequestSummary> = {}): JourneyPullRequest {
  return pr({ baseRef: "main", headRef: "release-main/v1", releaseChecks: PASSED, ...overrides });
}

function facts(overrides: Partial<ReleaseRcFacts> = {}): ReleaseRcFacts {
  return {
    sequence: 13,
    phase: "review",
    pendingRevision: null,
    approval: null,
    finalization: null,
    productionStopLabel: null,
    predecessor: null,
    updatedAt: "2026-10-26T12:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides: Partial<NonNullable<ReleaseRcFacts["approval"]>> = {}): NonNullable<ReleaseRcFacts["approval"]> {
  return {
    status: "active",
    progress: "final_checks",
    approvedAt: "2026-10-26T12:33:00.000Z",
    revision: 2,
    invalidMessage: null,
    runStatus: "checking",
    runActive: true,
    waitMessage: null,
    waitStalled: false,
    stopMessage: null,
    ...overrides,
  };
}

/** 新方式の候補（`release-rc/<番号>`） */
function rcCandidate(rc: ReleaseRcFacts | null, checks: Partial<PullRequestReleaseChecks> = {}, overrides: Partial<PullRequestSummary> = {}): JourneyPullRequest {
  return pr({ baseRef: "main", headRef: "release-rc/13", releaseChecks: { ...PASSED, rc, ...checks }, ...overrides });
}

function deploy(overrides: Partial<BranchFlowDeployState>): BranchFlowDeployState {
  return { kind: "running", htmlUrl: null, runId: 1, manual: false, autoRetried: false, ...overrides } as BranchFlowDeployState;
}

const check = (status: string) => ({ status }) as PullRequestSummary["ciChecks"][number];

function run(input: Partial<Input>): ReleaseJourney | null {
  return resolveReleaseJourney({ bumpPullRequest: null, candidatePullRequest: null, mergeTarget: null, deploy: null, ...input });
}

function states(journey: ReleaseJourney | null) {
  return journey?.steps.map((step) => step.state);
}

describe("resolveReleaseJourney（旧方式・#4930から引き継いだもの）", () => {
  it("リリースが動いていなければnull", () => {
    expect(run({})).toBeNull();
    // 成功したデプロイ・画面からの出し直しはリリースの工程として出さない
    for (const state of [deploy({ kind: "success" }), deploy({ manual: true })]) expect(run({ deploy: state })).toBeNull();
  });

  it("バンプPRのCI実行中は、最初の区切りだけが回る。旧方式なので公開承認・最終検証・稼働確認は対象外", () => {
    const journey = run({ bumpPullRequest: pr({ ciState: "pending", ciChecks: [check("in_progress")] }) });
    expect(states(journey)).toEqual(["running", "todo", "skipped", "skipped", "todo", "todo", "skipped"]);
    expect(journey?.headline).toMatchObject({ key: "create", label: "バージョンバンプのCI実行中", tone: "running" });
    expect(journey?.owner).toBe("auto");
    expect([journey?.done, journey?.total]).toEqual([0, 4]);
  });

  it("統合検証の実行中は、RC検証の中で並行する検証を内訳に出す", () => {
    const journey = run({
      candidatePullRequest: legacyCandidate({
        releaseChecks: {
          ...PASSED,
          aiReview: "running",
          integration: "running",
          started: { aiReview: false, integration: true, mac: false },
          aiReviewStage: { kind: "awaiting_integration" },
        },
      }),
    });
    expect(journey?.steps.find((s) => s.key === "verify")).toMatchObject({ state: "running", status: "統合検証中" });
    expect(journey?.checks?.map((c) => c.state)).toEqual(["done", "running", "waiting"]);
    expect(journey?.headline).toMatchObject({ key: "verify", tone: "running" });
  });

  it("検証が揃ってマージを待つ旧方式の候補は琥珀（人の番）", () => {
    const journey = run({ candidatePullRequest: legacyCandidate(), mergeTarget: "main" });
    expect(states(journey)).toEqual(["done", "done", "skipped", "skipped", "user", "todo", "skipped"]);
    expect(journey?.headline).toMatchObject({ label: "mainへマージ待ち", tone: "user" });
    expect(isReleaseJourneyNeedingUser(journey)).toBe(true);
    expect([journey?.done, journey?.total]).toEqual([2, 4]);
  });

  it("失敗は実行中より優先して見出しにする", () => {
    const journey = run({
      candidatePullRequest: legacyCandidate({ ciState: "pending", ciChecks: [check("in_progress")], releaseChecks: { ...PASSED, integration: "failed" } }),
    });
    expect(journey?.headline).toMatchObject({ key: "verify", label: "統合検証が失敗", tone: "failed" });
    expect(journey?.checks?.map((c) => c.state)).toEqual(["running", "failed", "done"]);
    expect(journey?.owner).toBe("user");
  });

  it("判断済み（#4814）の要確認は済みとして数え、未判断の要確認は人の番（赤の失敗とは分ける）", () => {
    const cleared = run({
      candidatePullRequest: legacyCandidate({
        releaseChecks: { ...PASSED, aiReview: "needs_check", aiReviewStage: { kind: "needs_check", autoReevaluated: false, items: ["findings"], cleared: true } },
      }),
    });
    expect(cleared?.checks?.find((c) => c.key === "review")?.state).toBe("done");
    const open = run({
      candidatePullRequest: legacyCandidate({
        releaseChecks: { ...PASSED, aiReview: "needs_check", aiReviewStage: { kind: "needs_check", autoReevaluated: false, items: ["findings"], cleared: false } },
      }),
    });
    expect(open?.steps.find((s) => s.key === "verify")?.state).toBe("user");
  });

  it("検証の記録を読めないときは推測で済みにせず取得不能にする", () => {
    const journey = run({ candidatePullRequest: legacyCandidate({ releaseChecks: { ...PASSED, unavailable: true } }) });
    expect(journey?.checks?.slice(1).map((c) => c.state)).toEqual(["unknown", "unknown"]);
    expect(journey?.steps.find((s) => s.key === "verify")?.state).toBe("unknown");
    expect(journey?.owner).toBe("none");
  });

  it("候補でないmain向けPRは統合検証・全体レビューを対象外にする", () => {
    const journey = run({ candidatePullRequest: pr({ baseRef: "main", headRef: "develop" }), mergeTarget: "main" });
    expect(journey?.checks?.map((c) => c.state)).toEqual(["done", "skipped", "skipped"]);
  });

  it("マージ後のデプロイは本番反映の区切りが引き継ぐ", () => {
    const running = run({ deploy: deploy({ kind: "running" }) });
    expect(states(running)).toEqual(["done", "done", "skipped", "skipped", "done", "running", "skipped"]);
    expect(running?.headline?.label).toBe("本番反映中");
    const failed = run({ deploy: deploy({ kind: "failure", autoRetried: true }) });
    expect(failed?.headline).toMatchObject({ label: "再デプロイも失敗", tone: "failed" });
    expect(failed?.owner).toBe("user");
  });
});

describe("resolveReleaseJourney（新方式の候補・#5076）", () => {
  it("作成を受け付けた直後（PRがまだ無い）は「作成中（受付済み）」で、人の番にしない", () => {
    const journey = run({ detached: facts({ phase: "creating", pendingRevision: { revision: 1, reason: "initial" } }) });
    expect(journey?.steps[0]).toMatchObject({ state: "running", status: "RC-13を作成中（受付済み）" });
    expect(journey?.owner).toBe("auto");
    expect(journey?.candidateLabel).toBe("RC-13");
    expect(isReleaseJourneyNeedingUser(journey)).toBe(false);
  });

  it("作り直しの元の候補は注記だけにし、進捗に数えない", () => {
    const journey = run({ detached: facts({ phase: "creating", predecessor: { sequence: 12, cancelReason: "作り直し" } }) });
    expect(journey?.predecessor).toBe("RC-12は取り消し済み（作り直し）。この候補の進捗には数えません");
    expect(journey?.done).toBe(0);
  });

  it("修正系列が対応中なら、RC検証は修正中で担当は自動", () => {
    const journey = run({
      candidatePullRequest: rcCandidate(facts(), {
        aiReview: "needs_check",
        fix: { status: "fix_in_progress", issueNumber: 5101, sourceKind: "review_finding", stalled: false, reason: null },
      }),
    });
    expect(journey?.steps.find((s) => s.key === "verify")).toMatchObject({ state: "fixing", status: "修正Issue #5101を対応中" });
    expect(journey?.owner).toBe("auto");
    expect(journey?.next).toContain("再検証");
  });

  it("修正系列を読めなかったら、要確認を修正中とも人の番とも決めない", () => {
    const journey = run({ candidatePullRequest: rcCandidate(facts(), { aiReview: "needs_check", unavailableParts: ["fix"] }) });
    expect(journey?.checks?.find((c) => c.key === "review")?.state).toBe("unknown");
  });

  it("修正の取り込み中は、検証結果より取り込みを優先する", () => {
    const journey = run({ candidatePullRequest: rcCandidate(facts({ pendingRevision: { revision: 3, reason: "fix_import" } })) });
    expect(journey?.steps.find((s) => s.key === "verify")).toMatchObject({ state: "fixing", status: "修正を候補へ取り込み中（revision 3）" });
  });

  it("検証が揃った候補は公開承認があなたの番", () => {
    const journey = run({ candidatePullRequest: rcCandidate(facts()) });
    expect(states(journey)).toEqual(["done", "done", "user", "todo", "todo", "todo", "todo"]);
    expect(journey?.headline).toMatchObject({ key: "approve", label: "公開承認待ち" });
    expect(journey?.next).toContain("自動で進みます");
    expect(isReleaseJourneyNeedingUser(journey)).toBe(true);
  });

  it("承認の直後（最終検証中）は人の番に戻らず、mainマージは自動処理待ち（#5064の後続）", () => {
    const journey = run({
      candidatePullRequest: rcCandidate(facts({ phase: "preparing", approval: approval(), finalization: { status: "applied", failureReason: null, updatedAt: "" } }), {
        integration: "running",
        started: { aiReview: false, integration: true, mac: false },
        publishApproved: true,
      }),
    });
    expect(states(journey)).toEqual(["done", "done", "done", "running", "waiting", "todo", "todo"]);
    expect(journey?.steps.find((s) => s.key === "approve")?.at).toBe("2026-10-26T12:33:00.000Z");
    expect(journey?.headline?.label).toMatch(/^最終検証: /);
    expect(journey?.others).toEqual(["最終検証の合格待ち"]);
    expect(journey?.owner).toBe("auto");
    expect(isReleaseJourneyNeedingUser(journey)).toBe(false);
  });

  it("正式バンプの要求中は「正式バンプ中」", () => {
    const journey = run({
      candidatePullRequest: rcCandidate(facts({ phase: "preparing", approval: approval(), finalization: { status: "requested", failureReason: null, updatedAt: "" } }), { publishApproved: true }),
    });
    expect(journey?.steps.find((s) => s.key === "final")).toMatchObject({ state: "running", status: "正式バンプ中" });
  });

  it("最終検証の合格後は、mainマージの具体的な待機先を出す", () => {
    const journey = run({
      candidatePullRequest: rcCandidate(
        facts({ phase: "awaiting_approval", approval: approval({ progress: "auto_publish", runStatus: "merging", waitMessage: "CIの完了待ち" }) }),
        { publishApproved: true },
      ),
    });
    expect(journey?.steps.find((s) => s.key === "merge")).toMatchObject({ state: "waiting", status: "mainマージの条件確認中（CIの完了待ち）" });
    expect(journey?.owner).toBe("auto");
  });

  it("自動公開が止まったら失敗で、理由を添えて人へ渡す", () => {
    const journey = run({
      candidatePullRequest: rcCandidate(facts({ phase: "awaiting_approval", approval: approval({ progress: "stopped", runActive: false, stopMessage: "CIが失敗しました" }) }), {
        publishApproved: true,
      }),
    });
    expect(journey?.headline).toMatchObject({ key: "merge", label: "自動公開が停止", tone: "failed", title: "CIが失敗しました" });
    expect(journey?.owner).toBe("user");
  });

  it("承認が失効したら、理由を添えて再承認を人の番にする（#313の例）", () => {
    const journey = run({
      candidatePullRequest: rcCandidate(
        facts({ phase: "awaiting_approval", approval: approval({ status: "invalidated", progress: "invalidated", invalidMessage: "承認した後に候補が更新・置換されました" }) }),
      ),
    });
    expect(journey?.headline).toMatchObject({ key: "approve", label: "公開承認が失効", tone: "user", title: "承認した後に候補が更新・置換されました" });
    expect(journey?.next).toContain("承認し直す");
    expect(journey?.steps.find((s) => s.key === "merge")?.state).toBe("todo");
  });

  it("候補の記録を読めないときは承認以降を取得不能にし、済みに数えない", () => {
    const journey = run({ candidatePullRequest: rcCandidate(null, { unavailableParts: ["rc"] }) });
    expect(journey?.steps.slice(2, 5).map((s) => s.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(journey?.done).toBe(2);
  });

  it("マージ後の候補は、PRが閉じても同じ候補として本番反映・稼働確認を追う", () => {
    const deploying = run({ detached: facts({ phase: "deploying" }), deploy: deploy({ kind: "running" }) });
    expect(states(deploying)).toEqual(["done", "done", "done", "done", "done", "running", "todo"]);
    const verifying = run({ detached: facts({ phase: "verifying_production" }), deploy: deploy({ kind: "success" }) });
    expect(verifying?.headline).toMatchObject({ key: "prod", label: "稼働版を照合中", tone: "running" });
    const stopped = run({ detached: facts({ phase: "verifying_production", productionStopLabel: "証拠未設定" }) });
    expect(stopped?.headline).toMatchObject({ key: "prod", label: "稼働確認が停止（証拠未設定）", tone: "failed" });
    expect(stopped?.owner).toBe("user");
  });

  it("画面の取得に失敗している間は、動いている工程を取得不能にする", () => {
    const journey = run({ detached: facts({ phase: "deploying" }), snapshot: { failed: true } });
    expect(journey?.steps.find((s) => s.key === "deploy")?.state).toBe("unknown");
    expect(journey?.stale).toBe(true);
    expect(journey?.owner).toBe("none");
  });
});
