import { describe, expect, it } from "vitest";

import {
  isLegacyReleaseCandidateHeadRef,
  isRcReleaseCandidateHeadRef,
  isReleaseCandidateHeadRef,
  legacyReleaseVersionOf,
  rcSequenceOf,
} from "@/lib/release-branch";
import { classifyPullRequest } from "@/lib/pull-request-list";
import { evaluateReleaseMergeGate, isReleasePullRequest, type ReleaseVerificationRecord } from "@/lib/release-merge-gate";
import {
  buildRcFinalizeContract,
  canCancelRc,
  classifyRcBlock,
  canTransitionRcPhase,
  decideLegacyMigration,
  decideRcImport,
  decideRcReport,
  deriveRcStatus,
  isRcRevisionPendingExpired,
  parseRcCallerSupport,
  parseRcRequestKey,
  RC_REVISION_TTL_MS,
  type RcStatusInput,
} from "@/lib/release-rc";

const BASE = "b".repeat(40);
const HEAD1 = "1".repeat(40);
const HEAD2 = "2".repeat(40);

function gate(records: ReleaseVerificationRecord[], headSha = HEAD2) {
  return evaluateReleaseMergeGate({ current: { baseSha: BASE, headSha }, records, enforced: true });
}

function input(overrides: Partial<RcStatusInput> = {}): RcStatusInput {
  return {
    phase: "review",
    current: { revision: 2, headSha: HEAD2 },
    pending: null,
    pullRequest: { number: 10, state: "open", merged: false, baseSha: BASE, headSha: HEAD2 },
    gate: gate([]),
    fixInProgress: false,
    ...overrides,
  };
}

describe("候補ブランチの判定", () => {
  it("旧方式・新方式を区別し、バンプPRとは重ならない", () => {
    expect(isLegacyReleaseCandidateHeadRef("release-main/v8.56.0")).toBe(true);
    expect(isRcReleaseCandidateHeadRef("release-rc/12")).toBe(true);
    expect(isRcReleaseCandidateHeadRef("release-rc/12-x")).toBe(false);
    expect(isReleaseCandidateHeadRef("release/v8.56.0")).toBe(false);
    expect(isReleaseCandidateHeadRef("develop")).toBe(false);
    expect(rcSequenceOf("release-rc/12")).toBe(12);
    expect(legacyReleaseVersionOf("release-main/v8.56.0")).toBe("8.56.0");
    expect(legacyReleaseVersionOf("release-rc/12")).toBeNull();
  });

  it("新方式の候補PRもリリースPRとして分類され、検証ゲートの対象になる", () => {
    expect(classifyPullRequest({ baseRef: "main", headRef: "release-rc/3" })).toBe("release");
    expect(isReleasePullRequest({ baseRef: "main", headRef: "release-rc/3" })).toBe(true);
    expect(isReleasePullRequest({ baseRef: "develop", headRef: "release-rc/3" })).toBe(false);
    expect(isReleasePullRequest({ baseRef: "main", headRef: "release-main/v1.2.3" })).toBe(true);
  });
});

describe("deriveRcStatus", () => {
  it.each(["preparing", "awaiting_approval", "review"] as const)("マージ済みなら内部%sでも再承認を案内しない（#4673）", (phase) => {
    const result = deriveRcStatus(input({ phase, pullRequest: { number: 10, state: "closed", merged: true, baseSha: BASE, headSha: HEAD2 } }));
    expect(result.status).toBe("deploying");
    expect(result.reason).toContain("マージ済み");
    expect(result.reason).not.toContain("合格");
  });

  it("全体レビューが統合検証の証跡待ち・再評価中なら、要修正でなく検証中にする（#4664）", () => {
    const g = gate([
      { kind: "integration", state: "passed", baseSha: BASE, headSha: HEAD2 },
      { kind: "ai_review", state: "passed", baseSha: BASE, headSha: HEAD2, unverifiedScope: "検証ランナーはrunning" },
    ]);
    expect(deriveRcStatus(input({ gate: g })).status).toBe("needs_fix");
    expect(deriveRcStatus(input({ gate: g, reviewStage: { kind: "reevaluating" } })).status).toBe("verifying");
    // 統合検証が失敗していれば、段階より失敗を優先する（誤合格・待てば進むと見せない）
    const failed = gate([
      { kind: "integration", state: "failed", baseSha: BASE, headSha: HEAD2 },
      { kind: "ai_review", state: "passed", baseSha: BASE, headSha: HEAD2, unverifiedScope: "x" },
    ]);
    expect(deriveRcStatus(input({ gate: failed, reviewStage: { kind: "reevaluating" } })).status).toBe("needs_fix");
  });

  it("止めているのが全体レビューだけなら、承知で進む道を開く（#4807）", () => {
    const reviewFailed = gate([
      { kind: "integration", state: "passed", baseSha: BASE, headSha: HEAD2 },
      { kind: "ai_review", state: "needs_check", baseSha: BASE, headSha: HEAD2 },
    ]);
    const status = deriveRcStatus(input({ gate: reviewFailed }));
    expect(status).toMatchObject({ status: "needs_fix", aiReviewWaivable: true });
    // 全体レビューが未完了（実行中）でも外せる
    const running = gate([
      { kind: "integration", state: "passed", baseSha: BASE, headSha: HEAD2 },
      { kind: "ai_review", state: "running", baseSha: BASE, headSha: HEAD2 },
    ]);
    expect(deriveRcStatus(input({ gate: running }))).toMatchObject({ status: "verifying", aiReviewWaivable: true });
    // 修正中・記録に無いpush・統合検証が未合格なら外さない
    expect(deriveRcStatus(input({ gate: reviewFailed, fixInProgress: true })).aiReviewWaivable).toBe(false);
    expect(
      deriveRcStatus(input({ gate: reviewFailed, pullRequest: { number: 10, state: "open", merged: false, baseSha: BASE, headSha: HEAD1 } })).aiReviewWaivable,
    ).toBe(false);
    const integrationRunning = gate([
      { kind: "integration", state: "running", baseSha: BASE, headSha: HEAD2 },
      { kind: "ai_review", state: "failed", baseSha: BASE, headSha: HEAD2 },
    ]);
    expect(deriveRcStatus(input({ gate: integrationRunning })).aiReviewWaivable).toBe(false);
  });

  it("現在revisionのSHAに一致する合格だけで公開準備可能になる", () => {
    const passed = gate([
      { kind: "integration", state: "passed", baseSha: BASE, headSha: HEAD2 },
      { kind: "ai_review", state: "passed", baseSha: BASE, headSha: HEAD2 },
    ]);
    expect(deriveRcStatus(input({ gate: passed })).status).toBe("ready_to_prepare");
  });

  it("旧revisionの合格や遅れて届いた結果は、現在の合格にならない", () => {
    const stale = gate([
      { kind: "integration", state: "passed", baseSha: BASE, headSha: HEAD1 },
      { kind: "ai_review", state: "passed", baseSha: BASE, headSha: HEAD1 },
    ]);
    expect(deriveRcStatus(input({ gate: stale })).status).toBe("awaiting_verification");
  });

  it("失敗・要確認は要修正、修正系列の進行中は修正中", () => {
    const failed = gate([
      { kind: "integration", state: "failed", baseSha: BASE, headSha: HEAD2 },
      { kind: "ai_review", state: "passed", baseSha: BASE, headSha: HEAD2 },
    ]);
    expect(deriveRcStatus(input({ gate: failed })).status).toBe("needs_fix");
    expect(deriveRcStatus(input({ gate: failed, fixInProgress: true })).status).toBe("fixing");
    const partial = gate([
      { kind: "integration", state: "passed", baseSha: BASE, headSha: HEAD2 },
      { kind: "ai_review", state: "passed", baseSha: BASE, headSha: HEAD2, unverifiedScope: "src/a.ts" },
    ]);
    expect(deriveRcStatus(input({ gate: partial })).status).toBe("needs_fix");
  });

  it("実行中は検証中", () => {
    const running = gate([{ kind: "integration", state: "running", baseSha: BASE, headSha: HEAD2 }]);
    expect(deriveRcStatus(input({ gate: running })).status).toBe("verifying");
  });

  it("更新要求が未完了の間は修正中（初回は作成中）で、旧結果を合格にしない", () => {
    const passed = gate([
      { kind: "integration", state: "passed", baseSha: BASE, headSha: HEAD2 },
      { kind: "ai_review", state: "passed", baseSha: BASE, headSha: HEAD2 },
    ]);
    expect(deriveRcStatus(input({ gate: passed, pending: { revision: 3, reason: "fix_import" } })).status).toBe("fixing");
    expect(deriveRcStatus(input({ phase: "creating", current: null, pending: { revision: 1, reason: "initial" } })).status).toBe("creating");
  });

  it("記録に無いpushでheadが変わったら合格にせず確認を求める", () => {
    const passed = gate(
      [
        { kind: "integration", state: "passed", baseSha: BASE, headSha: HEAD1 },
        { kind: "ai_review", state: "passed", baseSha: BASE, headSha: HEAD1 },
      ],
      HEAD1,
    );
    const result = deriveRcStatus(
      input({ gate: passed, pullRequest: { number: 10, state: "open", merged: false, baseSha: BASE, headSha: HEAD1 } }),
    );
    expect(result.status).toBe("needs_fix");
    expect(result.attention).not.toBeNull();
  });

  it("取得できないときは成功と推測しない", () => {
    expect(deriveRcStatus(input({ gate: null })).status).toBe("awaiting_verification");
    expect(deriveRcStatus(input({ pullRequest: null })).attention).not.toBeNull();
  });

  it("記録で持つ段階はそのまま出る", () => {
    expect(deriveRcStatus(input({ phase: "cancelled" })).status).toBe("cancelled");
    expect(deriveRcStatus(input({ phase: "preparing" })).status).toBe("preparing");
  });
});

describe("段階の遷移", () => {
  it("mainへの反映以降は取り消せない", () => {
    expect(canCancelRc("review")).toBe(true);
    expect(canCancelRc("awaiting_approval")).toBe(true);
    expect(canCancelRc("deploying")).toBe(false);
    expect(canCancelRc("completed")).toBe(false);
  });

  it("検証段階から稼働確認へ飛ばない", () => {
    expect(canTransitionRcPhase("review", "preparing")).toBe(true);
    expect(canTransitionRcPhase("review", "deploying")).toBe(false);
    expect(canTransitionRcPhase("preparing", "review")).toBe(true);
  });
});

describe("decideRcImport", () => {
  const prs = [
    { number: 21, mergeSha: "a".repeat(40), title: "修正" },
    { number: 22, mergeSha: "c".repeat(40), title: "無関係" },
  ];

  it("関連修正は承認なしで取り込み、範囲外は承認を求める", () => {
    expect(decideRcImport({ selected: prs, scope: { relatedFixPrs: [21], approvedExtraPrs: [] }, approveExtra: [] })).toEqual({
      ok: false,
      error: "approval_required",
      unapproved: [22],
    });
  });

  it("明示的に承認した範囲外PRは記録して取り込む", () => {
    const result = decideRcImport({ selected: prs, scope: { relatedFixPrs: [21], approvedExtraPrs: [] }, approveExtra: [22] });
    expect(result.ok && result.newlyApproved).toEqual([22]);
    expect(result.ok && result.prs.map((p) => p.related)).toEqual([true, false]);
  });

  it("空の選択は拒否する", () => {
    expect(decideRcImport({ selected: [], scope: { relatedFixPrs: [], approvedExtraPrs: [] }, approveExtra: [] }).ok).toBe(false);
  });
});

describe("decideRcReport", () => {
  const frozen = "f".repeat(40);
  const pr = { number: 10, baseSha: BASE, headSha: frozen, headRef: "release-rc/3" };

  it("初回は固定したdevelopのSHAそのものだけを受け付ける", () => {
    const row = { status: "requested" as const, revision: 1, expectedHeadSha: null, reason: "initial" as const };
    expect(decideRcReport({ row, frozenDevelopSha: frozen, observation: { pullRequest: pr, fastForward: true } }).action).toBe("apply");
    expect(
      decideRcReport({ row, frozenDevelopSha: frozen, observation: { pullRequest: { ...pr, headSha: HEAD1 }, fastForward: true } }).action,
    ).toBe("fail");
  });

  it("更新は早送りのときだけ受け付け、未更新・書き換えは失敗にする", () => {
    const row = { status: "requested" as const, revision: 2, expectedHeadSha: HEAD1, reason: "fix_import" as const };
    const moved = { ...pr, headSha: HEAD2 };
    expect(decideRcReport({ row, frozenDevelopSha: frozen, observation: { pullRequest: moved, fastForward: true } }).action).toBe("apply");
    expect(decideRcReport({ row, frozenDevelopSha: frozen, observation: { pullRequest: moved, fastForward: false } }).action).toBe("fail");
    expect(
      decideRcReport({ row, frozenDevelopSha: frozen, observation: { pullRequest: { ...pr, headSha: HEAD1 }, fastForward: true } }).action,
    ).toBe("fail");
  });

  it("再送・期限切れ後の報告では状態を戻さない", () => {
    const applied = { status: "applied" as const, revision: 2, expectedHeadSha: HEAD1, reason: "fix_import" as const };
    expect(decideRcReport({ row: applied, frozenDevelopSha: frozen, observation: { pullRequest: pr, fastForward: true } })).toEqual({
      action: "ignore",
      reason: "already_applied",
    });
    const expired = { ...applied, status: "expired" as const };
    expect(decideRcReport({ row: expired, frozenDevelopSha: frozen, observation: { pullRequest: pr, fastForward: true } }).action).toBe(
      "ignore",
    );
  });
});

describe("旧方式からの移行", () => {
  it("先端が版上げのコミットなら、その親を固定点にする", () => {
    expect(decideLegacyMigration({ message: "v8.57.0をリリースする。\n\n本文", parents: ["p".repeat(40)] })).toEqual({
      ok: true,
      freezeSha: "p".repeat(40),
    });
  });

  it("作り直し・履歴修復で積まれた候補は移行しない", () => {
    expect(decideLegacyMigration({ message: "履歴修復: mainの祖先を取り込む", parents: ["a", "b"] })).toEqual({ ok: false, reason: "merge_head" });
    expect(decideLegacyMigration({ message: "fix: 何か", parents: ["a"] })).toEqual({ ok: false, reason: "not_bump_commit" });
  });
});

describe("callerの対応", () => {
  it("dispatch入力とreusableへの受け渡しの両方があるときだけ対応", () => {
    const caller = `on:\n  workflow_dispatch:\n    inputs:\n      candidate_request:\n        type: string\njobs:\n  release:\n    with:\n      candidate-request: x\n`;
    expect(parseRcCallerSupport(caller)).toEqual({ supported: true });
    expect(parseRcCallerSupport("      rebuild_selection:\n")).toEqual({ supported: false, reason: "caller_without_input" });
    expect(parseRcCallerSupport(null)).toEqual({ supported: false, reason: "caller_unreadable" });
  });
});

describe("公開準備への契約", () => {
  const candidate = { id: "c1", sequence: 3, frozenDevelopSha: "f".repeat(40), frozenPrNumbers: [1, 2] };
  const current = { revision: 2, prNumber: 10, baseSha: BASE, headSha: HEAD2, importedPrNumbers: [5, 2] };

  it("合格しているときだけ作れ、含めるPRを重複なく持つ", () => {
    expect(buildRcFinalizeContract({ candidate, current, status: "ready_to_prepare" })?.includedPrs).toEqual([1, 2, 5]);
    expect(buildRcFinalizeContract({ candidate, current, status: "needs_fix" })).toBeNull();
    expect(buildRcFinalizeContract({ candidate, current, status: "ready_to_prepare" })?.requiresAiReviewWaiver).toBe(false);
    // 止めているのが全体レビューだけなら、承知で進む明示を要する契約を作る（#4807）
    expect(buildRcFinalizeContract({ candidate, current, status: "needs_fix", aiReviewWaivable: true })?.requiresAiReviewWaiver).toBe(true);
  });
});

describe("要求キーと期限", () => {
  it("要求キーの形式を検証する", () => {
    expect(parseRcRequestKey("abcDEF12-_")).toBe("abcDEF12-_");
    expect(parseRcRequestKey("short")).toBeNull();
    expect(parseRcRequestKey("../etc")).toBeNull();
  });

  it("結果の無いまま期限を過ぎた要求は失効扱い", () => {
    const createdAt = new Date("2026-10-12T00:00:00Z");
    expect(isRcRevisionPendingExpired({ status: "requested", createdAt }, new Date(createdAt.getTime() + RC_REVISION_TTL_MS))).toBe(true);
    expect(isRcRevisionPendingExpired({ status: "requested", createdAt }, new Date(createdAt.getTime() + 1000))).toBe(false);
    expect(isRcRevisionPendingExpired({ status: "applied", createdAt }, new Date(createdAt.getTime() + RC_REVISION_TTL_MS))).toBe(false);
  });
});

describe("classifyRcBlock（#4628）", () => {
  const base = { candidateId: "c1", sequence: 1, prNumber: 4610 };

  it("PRがマージ済みなのに内部段階がレビューのままなら状態不整合とし、検証合格・公開完了を推測しない", () => {
    const block = classifyRcBlock({ ...base, phase: "review", status: "deploying", statusLabel: "本番反映中" });
    expect(block.kind).toBe("inconsistent");
    expect(block.label).toBe("RC-1");
    expect(block.cancellable).toBe(true);
    expect(block.reason).not.toContain("本番反映中");
    expect(block.facts.join(" ")).toContain("#4610");
    expect(block.unconfirmed.join(" ")).toContain("検証の合否");
  });

  it("通常の進行中の候補は不整合にせず、現在の工程と関連PRを示す", () => {
    const block = classifyRcBlock({ ...base, sequence: 2, prNumber: 4701, phase: "review", status: "verifying", statusLabel: "検証中" });
    expect(block.kind).toBe("in_progress");
    expect(block.facts).toEqual(["関連PR: #4701", "現在の工程: 検証中"]);
  });

  it("実際に本番反映中の候補（phase=deploying）は不整合にせず、取り消せない", () => {
    const block = classifyRcBlock({ ...base, phase: "deploying", status: "deploying", statusLabel: "本番反映中" });
    expect(block.kind).toBe("in_progress");
    expect(block.cancellable).toBe(false);
  });
});

describe("本番の稼働確認の停止（#4712）", () => {
  it("止まった公開済み候補は「稼働確認中」ではなく停止として、原因と次の操作を出す", () => {
    const view = deriveRcStatus(input({ phase: "verifying_production", production: { stopReason: "contract_missing", method: null, awaitingSuccessor: false } }));
    expect(view.status).toBe("production_stopped");
    expect(view.label).toBe("稼働確認が停止（証拠未設定）");
    expect(view.reason).toContain("APP_COMMIT_SHA");
    expect(view.reason).toContain("次の候補");
    expect(view.attention).not.toBeNull();
  });

  it("デプロイ失敗はデプロイ中の段階でも停止として出す", () => {
    expect(deriveRcStatus(input({ phase: "deploying", production: { stopReason: "deploy_failed", method: null, awaitingSuccessor: false } })).status).toBe("production_stopped");
  });

  it("後続の確認待ちへ移った候補は、次の候補で完了することを出す", () => {
    const view = deriveRcStatus(input({ phase: "verifying_production", production: { stopReason: "contract_missing", method: null, awaitingSuccessor: true } }));
    expect(view.reason).toContain("次の候補を開始済み");
  });

  it("止まっていなければ従来どおり稼働確認中", () => {
    expect(deriveRcStatus(input({ phase: "verifying_production", production: { stopReason: null, method: null, awaitingSuccessor: false } })).status).toBe("verifying_production");
  });

  it("ソース公開の完了は、実機配備を確かめていないことを出す（pi0w）", () => {
    const view = deriveRcStatus(input({ phase: "completed", production: { stopReason: null, method: "source_publish", awaitingSuccessor: false } }));
    expect(view).toMatchObject({ status: "completed", label: "ソース公開済み" });
    expect(view.reason).toContain("実機への配備はこの確認の対象外");
  });

  it("開始判定は停止を「進行中」と区別し、理由・次の操作・取消不可を返す", () => {
    const block = classifyRcBlock({
      candidateId: "c1",
      sequence: 1,
      prNumber: 254,
      phase: "verifying_production",
      status: "production_stopped",
      statusLabel: "稼働確認が停止（証拠未設定）",
      productionStopReason: "contract_missing",
      statusReason: "理由と操作",
    });
    expect(block).toMatchObject({ kind: "production_stopped", label: "RC-1", cancellable: false, productionStopReason: "contract_missing", action: "理由と操作" });
    expect(block.reason).toContain("PR #254");
  });
});
