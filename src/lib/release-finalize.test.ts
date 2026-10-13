import { describe, expect, it } from "vitest";

import {
  buildInheritanceEvidence,
  categorizeChangedFile,
  decideFinalizeFailureHandling,
  decideFinalizeReadiness,
  decideFinalizeReport,
  decideFinalizeStart,
  decideInheritedVerification,
  decideMergedCandidate,
  decideReservationRelease,
  decideVersionReservation,
  deriveInheritedRecords,
  finalizeRequestKey,
  isBumpedToReservation,
  parseFinalizeCallerSupport,
  readVersionFromText,
  summarizeBumpDiff,
} from "@/lib/release-finalize";

const RULES = { versionFile: "package.json" };
const BASE = "b".repeat(40);
const PRE = "a".repeat(40);
const POST = "c".repeat(40);

describe("decideVersionReservation", () => {
  const base = { candidateId: "c1", mainVersion: "2.13.4", bumpKind: "minor" as const, existingTags: [], reservations: [] };

  it("mainの版を起点に予約する", () => {
    expect(decideVersionReservation(base)).toEqual({ action: "reserve", version: "2.14.0", release: [], skipped: [] });
  });

  it("再試行では同じ予約を使い、版を増やさない", () => {
    const result = decideVersionReservation({ ...base, reservations: [{ version: "2.14.0", candidateId: "c1", status: "reserved" }] });
    expect(result).toEqual({ action: "reuse", version: "2.14.0" });
  });

  it("上げ幅が変わったら古い予約を手放して取り直す", () => {
    const result = decideVersionReservation({
      ...base,
      bumpKind: "patch",
      reservations: [{ version: "2.14.0", candidateId: "c1", status: "reserved" }],
    });
    expect(result).toEqual({ action: "reserve", version: "2.13.5", release: ["2.14.0"], skipped: [] });
  });

  it("タグ・消費済みの版は欠番にして次のpatchへ進める", () => {
    const result = decideVersionReservation({
      ...base,
      existingTags: ["v2.14.0"],
      reservations: [{ version: "2.14.1", candidateId: "old", status: "consumed" }],
    });
    expect(result).toEqual({ action: "reserve", version: "2.14.2", release: [], skipped: ["2.14.0", "2.14.1"] });
  });

  it("他の候補が保持している版は取らない", () => {
    const result = decideVersionReservation({ ...base, reservations: [{ version: "2.14.0", candidateId: "other", status: "reserved" }] });
    expect(result).toMatchObject({ action: "conflict", reason: "reserved_by_other" });
  });

  it("mainの版が読めなければ決めない", () => {
    expect(decideVersionReservation({ ...base, mainVersion: null })).toMatchObject({ action: "conflict", reason: "unreadable_main_version" });
  });

  it("手放した予約は再利用できる", () => {
    const result = decideVersionReservation({ ...base, reservations: [{ version: "2.14.0", candidateId: "dead", status: "released" }] });
    expect(result).toMatchObject({ action: "reserve", version: "2.14.0" });
  });
});

describe("isBumpedToReservation", () => {
  it("mainより新しく予約版と一致するときだけバンプ済み", () => {
    expect(isBumpedToReservation({ headVersion: "2.14.0", mainVersion: "2.13.4", reservedVersion: "2.14.0" })).toBe(true);
  });
  it("developに残った古い版（main以下）はバンプ済みと読まない", () => {
    expect(isBumpedToReservation({ headVersion: "2.13.4", mainVersion: "2.13.4", reservedVersion: "2.14.0" })).toBe(false);
    expect(isBumpedToReservation({ headVersion: "2.12.0", mainVersion: "2.13.4", reservedVersion: "2.14.0" })).toBe(false);
  });
  it("予約と違う版は一致しない", () => {
    expect(isBumpedToReservation({ headVersion: "2.15.0", mainVersion: "2.13.4", reservedVersion: "2.14.0" })).toBe(false);
  });
});

describe("decideReservationRelease", () => {
  it("公開前の予約は手放せる", () => {
    expect(decideReservationRelease({ status: "reserved", version: "2.14.0", existingTags: [], mainVersion: "2.13.4" })).toBe("release");
  });
  it("タグがある・mainへ入った版は消費済みにする", () => {
    expect(decideReservationRelease({ status: "reserved", version: "2.14.0", existingTags: ["v2.14.0"], mainVersion: "2.13.4" })).toBe("consume");
    expect(decideReservationRelease({ status: "reserved", version: "2.14.0", existingTags: [], mainVersion: "2.14.0" })).toBe("consume");
  });
  it("消費済みは触らない", () => {
    expect(decideReservationRelease({ status: "consumed", version: "2.14.0", existingTags: [], mainVersion: "2.13.4" })).toBe("keep");
  });
});

describe("差分の分類", () => {
  it("版・ロック・更新履歴・iOS・依存関係を分ける", () => {
    expect(categorizeChangedFile("package.json", RULES)).toBe("version");
    expect(categorizeChangedFile("package-lock.json", RULES)).toBe("version");
    expect(categorizeChangedFile(".github/release-notes.md", RULES)).toBe("changelog");
    expect(categorizeChangedFile("src/data/changelog.ts", RULES)).toBe("changelog");
    expect(categorizeChangedFile("ios/App/Info.plist", RULES)).toBe("ios_version");
    expect(categorizeChangedFile("pnpm-lock.yaml", RULES)).toBe("dependency");
    expect(categorizeChangedFile("src/index.ts", RULES)).toBe("other");
  });

  it("サブディレクトリの版ファイルでは、その階層のロックだけを版として扱う", () => {
    const rules = { versionFile: "frontend/package.json" };
    expect(categorizeChangedFile("frontend/package-lock.json", rules)).toBe("version");
    expect(categorizeChangedFile("package-lock.json", rules)).toBe("other");
  });
});

describe("decideInheritedVerification", () => {
  const passed = { state: "passed", baseSha: BASE, headSha: PRE };
  const onlyVersion = summarizeBumpDiff(["package.json", ".github/release-notes.md"], RULES);

  it("版と更新履歴だけの差分なら引き継ぐ", () => {
    expect(decideInheritedVerification({ kind: "ai_review", before: passed, currentBaseSha: BASE, diff: onlyVersion })).toMatchObject({ action: "inherit" });
  });
  it("バンプ前が合格でなければ再検証する", () => {
    expect(decideInheritedVerification({ kind: "integration", before: { ...passed, state: "failed" }, currentBaseSha: BASE, diff: onlyVersion })).toMatchObject({ action: "rerun" });
    expect(decideInheritedVerification({ kind: "integration", before: null, currentBaseSha: BASE, diff: onlyVersion })).toMatchObject({ action: "rerun" });
  });
  it("mainが進んでいれば再検証する", () => {
    expect(decideInheritedVerification({ kind: "integration", before: passed, currentBaseSha: "d".repeat(40), diff: onlyVersion })).toMatchObject({ action: "rerun" });
  });
  it("未確認の範囲がある合格は引き継がない", () => {
    expect(decideInheritedVerification({ kind: "ai_review", before: { ...passed, unverifiedScope: "src/a.ts" }, currentBaseSha: BASE, diff: onlyVersion })).toMatchObject({ action: "rerun" });
  });
  it("lifecycleがコードを変えたら全て再検証する", () => {
    const diff = summarizeBumpDiff(["package.json", "src/generated/version.ts"], RULES);
    expect(decideInheritedVerification({ kind: "ai_review", before: passed, currentBaseSha: BASE, diff })).toMatchObject({ action: "rerun" });
    expect(decideInheritedVerification({ kind: "ios", before: passed, currentBaseSha: BASE, diff })).toMatchObject({ action: "rerun" });
  });
  it("iOS（Mac）検証が必要なリポジトリでは、統合検証をバンプ後のheadで再実行し、全体レビューは引き継ぐ", () => {
    expect(decideInheritedVerification({ kind: "integration", before: passed, currentBaseSha: BASE, diff: onlyVersion, requireFreshIos: true })).toMatchObject({
      action: "rerun",
      reason: expect.stringContaining("iOS"),
    });
    expect(decideInheritedVerification({ kind: "ai_review", before: passed, currentBaseSha: BASE, diff: onlyVersion, requireFreshIos: true })).toMatchObject({ action: "inherit" });
  });
  it("iOS設定・依存関係が変わればiOS検証を再実行する", () => {
    const diff = summarizeBumpDiff(["package.json", "ios/App/Info.plist"], RULES);
    expect(decideInheritedVerification({ kind: "ios", before: passed, currentBaseSha: BASE, diff })).toMatchObject({ action: "rerun", reason: expect.stringContaining("iOS") });
  });
});

describe("deriveInheritedRecords", () => {
  const diff = summarizeBumpDiff(["package.json"], RULES);
  const evidence = [
    buildInheritanceEvidence({
      decision: { kind: "ai_review", action: "inherit", reason: "x" },
      from: { baseSha: BASE, headSha: PRE },
      to: { baseSha: BASE, headSha: POST },
      diff,
      now: new Date("2026-10-12T00:00:00Z"),
    }),
    buildInheritanceEvidence({
      decision: { kind: "integration", action: "rerun", reason: "x" },
      from: { baseSha: BASE, headSha: PRE },
      to: { baseSha: BASE, headSha: POST },
      diff,
      now: new Date("2026-10-12T00:00:00Z"),
    }),
  ];
  const originals = [
    { kind: "ai_review" as const, state: "passed" as const, baseSha: BASE, headSha: PRE },
    { kind: "integration" as const, state: "passed" as const, baseSha: BASE, headSha: PRE },
  ];

  it("引き継いだ種別だけ、バンプ後の対象へ派生の記録を作る（元の記録は変えない）", () => {
    const derived = deriveInheritedRecords({ finalization: { status: "applied", evidence }, originals });
    expect(derived).toEqual([{ kind: "ai_review", state: "passed", baseSha: BASE, headSha: POST, inheritedFromHeadSha: PRE }]);
    expect(originals[0].headSha).toBe(PRE);
  });
  it("元の結果が合格でなくなっていれば派生しない", () => {
    const derived = deriveInheritedRecords({
      finalization: { status: "applied", evidence },
      originals: [{ kind: "ai_review", state: "failed", baseSha: BASE, headSha: PRE }],
    });
    expect(derived).toEqual([]);
  });
  it("適用前（要求中・期限切れ）の記録からは派生しない", () => {
    expect(deriveInheritedRecords({ finalization: { status: "requested", evidence }, originals })).toEqual([]);
    expect(deriveInheritedRecords({ finalization: { status: "expired", evidence }, originals })).toEqual([]);
  });
  it("適用後に最終検証が失敗して修正工程へ戻った記録でも、引継ぎの事実は残る", () => {
    expect(deriveInheritedRecords({ finalization: { status: "failed", evidence }, originals })).toHaveLength(1);
    expect(deriveInheritedRecords({ finalization: { status: "superseded", evidence }, originals })).toHaveLength(1);
  });
});

describe("decideFinalizeStart", () => {
  const contract = { candidateId: "c1", revision: 3, prNumber: 12, baseSha: BASE, headSha: PRE };
  const input = {
    contract,
    phase: "review",
    observed: { prHeadSha: PRE, prBaseSha: BASE, mainSha: BASE },
    hasPending: false,
    expectedHeadSha: PRE,
  };
  it("合格した候補だけ始められる", () => {
    expect(decideFinalizeStart(input)).toEqual({ ok: true, contract });
    expect(decideFinalizeStart({ ...input, contract: null })).toEqual({ ok: false, error: "not_ready" });
  });
  it("レビュー段階以外・進行中は始めない", () => {
    expect(decideFinalizeStart({ ...input, phase: "preparing" })).toEqual({ ok: false, error: "wrong_phase" });
    expect(decideFinalizeStart({ ...input, hasPending: true })).toEqual({ ok: false, error: "in_progress" });
  });
  it("候補の更新・mainの前進は始めない", () => {
    expect(decideFinalizeStart({ ...input, expectedHeadSha: POST })).toEqual({ ok: false, error: "candidate_changed" });
    expect(decideFinalizeStart({ ...input, observed: { ...input.observed, prHeadSha: POST } })).toEqual({ ok: false, error: "candidate_changed" });
    expect(decideFinalizeStart({ ...input, observed: { ...input.observed, mainSha: "d".repeat(40) } })).toEqual({ ok: false, error: "main_advanced" });
  });
  it("観測できなければ始めない", () => {
    expect(decideFinalizeStart({ ...input, observed: null })).toEqual({ ok: false, error: "unobserved" });
  });
});

describe("decideFinalizeReport", () => {
  const row = { status: "requested" as const, preHeadSha: PRE };
  const ok = {
    pullRequest: { number: 12, baseSha: BASE, headSha: POST, draft: true },
    fastForward: true,
    changedFiles: ["package.json", ".github/release-notes.md"],
    headVersion: "2.14.0",
    mainVersion: "2.13.4",
  };
  const run = (over: Partial<Parameters<typeof decideFinalizeReport>[0]> = {}, obs: Partial<typeof ok> = {}) =>
    decideFinalizeReport({ row, expectedVersion: "2.14.0", rules: RULES, observation: { ...ok, ...obs }, ...over });
  it("早送りで確定する版へ書き換わっていれば適用する", () => {
    expect(run()).toMatchObject({ action: "apply", prNumber: 12, headSha: POST, version: "2.14.0" });
  });
  it("更新前は待つ・早送りでなければ失敗にする", () => {
    expect(run({}, { pullRequest: { ...ok.pullRequest, headSha: PRE }, headVersion: "2.13.4" })).toMatchObject({ action: "wait" });
    expect(run({}, { fastForward: false })).toMatchObject({ action: "fail" });
  });
  it("既に予約した版でバンプ済みの候補は、新しいコミットを作らずそのまま確定する", () => {
    const same = { pullRequest: { ...ok.pullRequest, headSha: PRE }, changedFiles: [] };
    expect(run({}, same)).toMatchObject({ action: "apply", headSha: PRE, version: "2.14.0" });
    expect(run({}, { ...same, headVersion: "2.13.4" })).toMatchObject({ action: "wait" });
  });
  it("版が確定できない・版ファイルが変わっていない・確定した版と違う版は失敗にする", () => {
    expect(run({ expectedVersion: null })).toMatchObject({ action: "fail" });
    expect(run({}, { changedFiles: [".github/release-notes.md"] })).toMatchObject({ action: "fail" });
    expect(run({}, { headVersion: "2.15.0" })).toMatchObject({ action: "fail" });
    expect(run({}, { headVersion: "2.13.4" })).toMatchObject({ action: "fail" });
  });
  it("再送・適用済みでは何もしない", () => {
    expect(run({ row: { ...row, status: "applied" } })).toEqual({ action: "ignore", reason: "already_applied" });
    expect(run({ row: { ...row, status: "failed" } })).toEqual({ action: "ignore", reason: "not_pending" });
  });
});

describe("callerの対応と版の読み取り", () => {
  const caller = [
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      finalize_request:",
    "jobs:",
    "  release:",
    "    with:",
    "      finalize-request: ${{ inputs.finalize_request }}",
    "      version-file: frontend/package.json",
    "      version-query: .version",
  ].join("\n");
  it("finalize_requestの受け渡しがあれば対応しており、版ファイルの設定を読む", () => {
    expect(parseFinalizeCallerSupport(caller)).toEqual({ supported: true, versionFile: "frontend/package.json", versionQuery: ".version", bumpCommand: false });
  });
  it("設定が無ければreusableの既定を使う", () => {
    const minimal = "on:\n  workflow_dispatch:\n    inputs:\n      finalize_request:\nwith:\n  finalize-request: x";
    expect(parseFinalizeCallerSupport(minimal)).toMatchObject({ supported: true, versionFile: "package.json", versionQuery: ".version" });
  });
  it("未対応・読めないcallerは理由を返す", () => {
    expect(parseFinalizeCallerSupport("on: push")).toEqual({ supported: false, reason: "caller_without_input" });
    expect(parseFinalizeCallerSupport(null)).toEqual({ supported: false, reason: "caller_unreadable" });
  });
  it("jsonの版を単純な経路で読み、読めなければnull", () => {
    expect(readVersionFromText('{"version":"2.14.0"}', ".version")).toBe("2.14.0");
    expect(readVersionFromText('{"app":{"version":"v1.2.3"}}', ".app.version")).toBe("1.2.3");
    expect(readVersionFromText('{"version":"x"}', ".version")).toBeNull();
    expect(readVersionFromText("not json", ".version")).toBeNull();
    expect(readVersionFromText('{"version":"1.0.0"}', ".version | tostring")).toBeNull();
    expect(readVersionFromText(null, ".version")).toBeNull();
  });
});

describe("decideFinalizeReadiness", () => {
  const checks = { ciState: "success" as const, draft: false };
  it("最終CIが成功し再検証が無ければ完了", () => {
    expect(decideFinalizeReadiness({ checks, pendingReverify: [] })).toEqual({ ready: true });
  });
  it("最終CIが未実施・失敗・不明、または再検証が残っていれば完了にしない", () => {
    expect(decideFinalizeReadiness({ checks: { ...checks, ciState: "pending" }, pendingReverify: [] })).toMatchObject({ ready: false, reason: "ci_pending" });
    expect(decideFinalizeReadiness({ checks: { ...checks, ciState: "failure" }, pendingReverify: [] })).toMatchObject({ ready: false, reason: "ci_failed" });
    expect(decideFinalizeReadiness({ checks: { ...checks, ciState: "unknown" }, pendingReverify: [] })).toMatchObject({ ready: false, reason: "ci_unknown" });
    expect(decideFinalizeReadiness({ checks, pendingReverify: ["ios"] })).toMatchObject({ ready: false, reason: "required_reverify" });
  });
});

describe("decideMergedCandidate", () => {
  const ready = { ready: true } as const;
  it("最終headのまま、最終CI・再検証が合格していれば本番反映の追跡へ進める", () => {
    expect(decideMergedCandidate({ headMatches: true, readiness: ready, reverifyStates: [] })).toEqual({ action: "advance" });
  });
  it("実行中のCI・検証の完了前のマージは進めずに待ち、理由を残す", () => {
    expect(decideMergedCandidate({ headMatches: true, readiness: { ready: false, reason: "ci_pending" }, reverifyStates: [] })).toMatchObject({ action: "wait", reason: expect.any(String) });
    expect(decideMergedCandidate({ headMatches: true, readiness: { ready: false, reason: "required_reverify" }, reverifyStates: ["running", "waiting"] })).toMatchObject({ action: "wait" });
    expect(decideMergedCandidate({ headMatches: true, readiness: { ready: false, reason: "ci_unknown" }, reverifyStates: [] })).toMatchObject({ action: "wait" });
  });
  it("最終検証の失敗・最終headと違う内容のマージは要対応として止める", () => {
    expect(decideMergedCandidate({ headMatches: true, readiness: { ready: false, reason: "ci_failed" }, reverifyStates: [] })).toMatchObject({ action: "hold" });
    expect(decideMergedCandidate({ headMatches: true, readiness: { ready: false, reason: "required_reverify" }, reverifyStates: ["failed"] })).toMatchObject({ action: "hold" });
    expect(decideMergedCandidate({ headMatches: false, readiness: ready, reverifyStates: [] })).toMatchObject({ action: "hold" });
  });
  it("待っても解消しない状態（依頼の失敗・要確認・失効）は待たずに止める", () => {
    for (const state of ["not_run", "needs_check", "invalidated"] as const) {
      expect(decideMergedCandidate({ headMatches: true, readiness: { ready: false, reason: "required_reverify" }, reverifyStates: [state] })).toMatchObject({ action: "hold" });
    }
    expect(decideMergedCandidate({ headMatches: true, readiness: { ready: false, reason: "ci_pending" }, reverifyStates: ["not_run"] })).toMatchObject({ action: "hold" });
  });
});

describe("decideFinalizeFailureHandling", () => {
  it("公開前の失敗は修正工程へ戻し、予約を保つ", () => {
    expect(decideFinalizeFailureHandling({ merged: false })).toEqual({ returnPhase: "review", keepReservation: true });
  });
  it("mainへ入った後は戻さない", () => {
    expect(decideFinalizeFailureHandling({ merged: true })).toBeNull();
  });
});

describe("finalizeRequestKey", () => {
  it("同じ候補・同じ前提headなら同じキーになる", () => {
    expect(finalizeRequestKey("cabc-123", PRE)).toBe(finalizeRequestKey("cabc-123", PRE));
    expect(finalizeRequestKey("cabc-123", PRE)).not.toBe(finalizeRequestKey("cabc-123", POST));
    expect(finalizeRequestKey("cabc-123", PRE)).toMatch(/^fin-[A-Za-z0-9]+-[0-9a-f]{12}$/);
  });
});
