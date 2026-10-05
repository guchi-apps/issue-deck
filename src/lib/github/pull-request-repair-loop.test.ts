import { describe, expect, it } from "vitest";

import { AUTO_REPAIR_MAX_ROUNDS, decideAutoRepairLoop } from "./pull-request-repair-loop";

const loop = (overrides = {}) => ({ status: "running" as const, headSha: "a", round: 0, currentKind: null, lastFingerprint: null, ...overrides });
const observed = (overrides = {}) => ({ state: "open" as const, headSha: "a", mergeable: true, ciState: "success" as const, review: "lgtm" as const, repairRunning: false, ...overrides });

describe("decideAutoRepairLoop", () => {
  it("conflict、CI、reviewの優先順位で1種類だけ選ぶ", () => {
    expect(decideAutoRepairLoop(loop(), observed({ mergeable: false, ciState: "failure", review: "changes-requested" }))).toMatchObject({ action: "dispatch", kind: "conflict" });
    expect(decideAutoRepairLoop(loop(), observed({ ciState: "failure", review: "changes-requested" }))).toMatchObject({ action: "dispatch", kind: "ci" });
    expect(decideAutoRepairLoop(loop(), observed({ review: "changes-requested" }))).toMatchObject({ action: "dispatch", kind: "review" });
  });

  it("新HEADのCIまたはレビューが未完了なら待機する", () => {
    expect(decideAutoRepairLoop(loop(), observed({ headSha: "b", ciState: "pending" }))).toEqual({ action: "wait" });
    expect(decideAutoRepairLoop(loop(), observed({ headSha: "b", review: null }))).toEqual({ action: "wait" });
  });

  it("mergeability未計算なら待機する", () => {
    expect(decideAutoRepairLoop(loop(), observed({ mergeable: null }))).toEqual({ action: "wait" });
  });

  it("レビュー不要PRはレビュー結果なしでも完了する", () => {
    expect(decideAutoRepairLoop(loop(), observed({ reviewRequired: false, review: null }))).toEqual({ action: "complete" });
  });

  it("現在HEADのLGTMで完了し、needs-checkは安全に停止する", () => {
    expect(decideAutoRepairLoop(loop(), observed())).toEqual({ action: "complete" });
    expect(decideAutoRepairLoop(loop(), observed({ review: "needs-check" }))).toEqual({ action: "stop", reason: "user_action_required" });
  });

  it("同じ指摘の再発と上限到達を停止する", () => {
    expect(decideAutoRepairLoop(loop({ lastFingerprint: "a:ci" }), observed({ ciState: "failure" }))).toEqual({ action: "stop", reason: "repeated_problem" });
    expect(decideAutoRepairLoop(loop({ round: AUTO_REPAIR_MAX_ROUNDS }), observed({ ciState: "failure" }))).toEqual({ action: "stop", reason: "max_rounds_reached" });
  });

  it("PRが閉じられたら停止する", () => {
    expect(decideAutoRepairLoop(loop(), observed({ state: "closed" }))).toEqual({ action: "stop", reason: "pull_request_closed" });
  });

  it("系列ごとの上限maxRoundsを守る（本番復旧系列が残り回数を渡す。#3998）", () => {
    expect(decideAutoRepairLoop(loop({ round: 1, maxRounds: 1 }), observed({ ciState: "failure" }))).toEqual({ action: "stop", reason: "max_rounds_reached" });
    expect(decideAutoRepairLoop(loop({ round: 0, maxRounds: 1 }), observed({ ciState: "failure" }))).toMatchObject({ action: "dispatch", kind: "ci" });
  });
});
