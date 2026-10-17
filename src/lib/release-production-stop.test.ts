import { describe, expect, it } from "vitest";

import type { DeployRunObservation } from "@/lib/deploy-recovery-series";
import {
  decideProductionStop,
  decideSuccessorProof,
  decideSuccessorStart,
  productionKindNotice,
  type ProductionStopInput,
} from "@/lib/release-production-stop";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const NEXT = "c".repeat(40);
const MERGED_AT = new Date("2026-10-16T22:46:02Z");
const minutes = (n: number) => new Date(MERGED_AT.getTime() + n * 60_000);

function run(over: Partial<DeployRunObservation> = {}): DeployRunObservation {
  return { id: 1, htmlUrl: "https://github.com/o/r/actions/runs/1", createdAt: MERGED_AT.toISOString(), headSha: SHA, status: "completed", conclusion: "success", attempt: 1, ...over };
}

function input(over: Partial<ProductionStopInput> = {}): ProductionStopInput {
  return { now: minutes(5), startedAt: MERGED_AT, mergeSha: SHA, kind: "deploy_without_version_check", waitingReason: "no_evidence", runs: [run()], ...over };
}

describe("decideProductionStop（#4712）", () => {
  it("照合の無いrepoでdeployが成功しても証拠が無ければ、待たずに「証拠未設定」で止める（car-care RC-1）", () => {
    expect(decideProductionStop(input())).toEqual({ stop: "contract_missing", detail: run().htmlUrl, stage: "verifying" });
  });

  it("公開URLが旧版・別のSHAを返していれば「旧版が応答」で止める", () => {
    expect(decideProductionStop(input({ waitingReason: "version_mismatch" }))).toMatchObject({ stop: "version_mismatch", stage: "verifying" });
  });

  it("公開URLを読めなければ「取得不能」で止める（照合が無いとも失敗したとも決めない）", () => {
    expect(decideProductionStop(input({ waitingReason: "probe_unreadable" }))).toMatchObject({ stop: "evidence_unreadable" });
  });

  it("照合付きのrepoで照合ジョブの成功を確かめられなければ「照合未完了」", () => {
    expect(decideProductionStop(input({ kind: "deploy_version_check" }))).toMatchObject({ stop: "version_unverified" });
  });

  it("deployの進行中・未起動は待つ（スピナー）。期限を過ぎて起動していなければ止める", () => {
    expect(decideProductionStop(input({ runs: [run({ status: "in_progress", conclusion: null })], waitingReason: "deploy_not_succeeded" }))).toEqual({ stop: null, stage: "deploying" });
    expect(decideProductionStop(input({ runs: [], waitingReason: "deploy_not_succeeded" }))).toEqual({ stop: null, stage: "deploying" });
    expect(decideProductionStop(input({ runs: [], waitingReason: "deploy_not_succeeded", now: minutes(61) }))).toMatchObject({ stop: "deploy_not_started" });
  });

  it("SHA不一致・旧版の応答で照合付きのdeployが落ちたら、再実行の猶予の後は「デプロイ失敗」で止める", () => {
    const failed = run({ conclusion: "failure", attempt: 1 });
    expect(decideProductionStop(input({ kind: "deploy_version_check", runs: [failed], waitingReason: "deploy_not_succeeded", now: minutes(3) }))).toEqual({ stop: null, stage: "deploying" });
    expect(decideProductionStop(input({ kind: "deploy_version_check", runs: [failed], waitingReason: "deploy_not_succeeded", now: minutes(20) }))).toMatchObject({ stop: "deploy_failed", detail: failed.htmlUrl });
    expect(decideProductionStop(input({ runs: [run({ conclusion: "failure", attempt: 2 })], waitingReason: "deploy_not_succeeded" }))).toMatchObject({ stop: "deploy_failed" });
  });

  it("重複実行・再実行は最新のrunだけを見る（古い成功で新しい失敗・進行中を上書きしない）", () => {
    const older = run({ id: 1, createdAt: minutes(1).toISOString() });
    const newer = run({ id: 2, createdAt: minutes(2).toISOString(), conclusion: "failure", attempt: 2 });
    expect(decideProductionStop(input({ runs: [older, newer], waitingReason: "deploy_not_succeeded" }))).toMatchObject({ stop: "deploy_failed" });
    const rerun = run({ id: 3, createdAt: minutes(3).toISOString(), status: "in_progress", conclusion: null });
    expect(decideProductionStop(input({ runs: [older, newer, rerun], waitingReason: "deploy_not_succeeded" }))).toEqual({ stop: null, stage: "deploying" });
  });

  it("別のコミットのrunは対象にしない。取消は待たずに止める", () => {
    expect(decideProductionStop(input({ runs: [run({ headSha: OLD })], waitingReason: "deploy_not_succeeded" }))).toEqual({ stop: null, stage: "deploying" });
    expect(decideProductionStop(input({ runs: [run({ conclusion: "cancelled" })], waitingReason: "deploy_not_succeeded" }))).toMatchObject({ stop: "deploy_cancelled" });
  });

  it("「稼働確認をやり直す」後は、押した時刻から待ち時間を数え直す", () => {
    const later = minutes(120);
    expect(decideProductionStop(input({ runs: [], waitingReason: "deploy_not_succeeded", now: later }))).toMatchObject({ stop: "deploy_not_started" });
    expect(decideProductionStop(input({ runs: [], waitingReason: "deploy_not_succeeded", now: later, startedAt: minutes(119) }))).toEqual({ stop: null, stage: "deploying" });
  });

  it("ソース公開（pi0w）は公開を期限まで待ち、過ぎたら「公開未確認」。配布workflowが無ければ証拠未設定", () => {
    expect(decideProductionStop(input({ kind: "source_publish_only", waitingReason: "source_not_published", runs: [] }))).toEqual({ stop: null, stage: "verifying" });
    expect(decideProductionStop(input({ kind: "source_publish_only", waitingReason: "source_not_published", runs: [], now: minutes(61) }))).toMatchObject({ stop: "source_unpublished" });
    expect(decideProductionStop(input({ kind: "unknown", waitingReason: "unknown_target", runs: [] }))).toMatchObject({ stop: "contract_missing" });
  });
});

describe("decideSuccessorProof（#4712）", () => {
  const successor = { sha: NEXT, runUrl: "u", kind: "deploy_version_check" as const, versionCheckPassed: true, includesCovered: true };

  it("照合付きで稼働を確かめた後続が対象を含むときだけ、後続による確認として完了させる", () => {
    expect(decideSuccessorProof({ coveredSha: SHA, successor })).toEqual({ ok: true, evidence: { coveredSha: SHA, successorSha: NEXT, deployRunUrl: "u" } });
  });

  it("対象を含まない・照合が無い・照合ジョブが成功していない・後続が対象そのもの・後続なしでは認めない", () => {
    expect(decideSuccessorProof({ coveredSha: SHA, successor: { ...successor, includesCovered: false } })).toEqual({ ok: false });
    expect(decideSuccessorProof({ coveredSha: SHA, successor: { ...successor, kind: "deploy_without_version_check" } })).toEqual({ ok: false });
    expect(decideSuccessorProof({ coveredSha: SHA, successor: { ...successor, versionCheckPassed: false } })).toEqual({ ok: false });
    expect(decideSuccessorProof({ coveredSha: SHA, successor: { ...successor, sha: SHA } })).toEqual({ ok: false });
    expect(decideSuccessorProof({ coveredSha: SHA, successor: null })).toEqual({ ok: false });
  });
});

describe("decideSuccessorStart（#4712）", () => {
  it("証拠未設定で止まり、developが照合を持つときだけ次の候補を始められる（循環を避ける）", () => {
    expect(decideSuccessorStart({ stopReason: "contract_missing", developKind: "deploy_version_check", slotTaken: false })).toEqual({ allowed: true });
  });

  it("developにまだ照合が無い・読めない・待ちの枠が埋まっていれば始めない", () => {
    expect(decideSuccessorStart({ stopReason: "contract_missing", developKind: "deploy_without_version_check", slotTaken: false }).allowed).toBe(false);
    expect(decideSuccessorStart({ stopReason: "contract_missing", developKind: null, slotTaken: false }).allowed).toBe(false);
    expect(decideSuccessorStart({ stopReason: "contract_missing", developKind: "deploy_version_check", slotTaken: true }).allowed).toBe(false);
  });

  it("失敗・取得不能・旧版の応答などでは、次の候補で代用せず元の候補を確かめ直す", () => {
    for (const stopReason of ["deploy_failed", "evidence_unreadable", "version_mismatch", "deploy_not_started", "version_unverified", null] as const) {
      expect(decideSuccessorStart({ stopReason, developKind: "deploy_version_check", slotTaken: false }).allowed).toBe(false);
    }
  });
});

describe("productionKindNotice（#4712）", () => {
  it("照合付きのWeb配備では注意を出さず、それ以外は公開後に何が要るかを開始前に出す", () => {
    expect(productionKindNotice("deploy_version_check")).toBeNull();
    expect(productionKindNotice(undefined)).toBeNull();
    expect(productionKindNotice("deploy_without_version_check")).toContain("公開URLの照合か人の確認");
    expect(productionKindNotice("source_publish_only")).toContain("実機への配備は稼働確認の対象外");
    expect(productionKindNotice("unknown")).toContain("人の確認");
    expect(productionKindNotice(null)).toContain("読めず");
  });
});
