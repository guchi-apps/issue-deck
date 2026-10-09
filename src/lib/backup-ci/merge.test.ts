import { describe, expect, it } from "vitest";

import {
  type BackupCiMergeInput,
  decideBackupCiMerge,
  issueNumberFromHeadRef,
  precheckBackupCiMerge,
} from "@/lib/backup-ci/merge";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function input(overrides: Partial<BackupCiMergeInput> = {}): BackupCiMergeInput {
  return {
    run: { id: "run1", status: "passed", headSha: HEAD, baseSha: BASE, mergeStatus: null },
    gate: { source: "backup", sourceRef: "run1", state: "success", headSha: HEAD, baseSha: BASE },
    pr: {
      state: "open",
      merged: false,
      draft: false,
      headSha: HEAD,
      baseSha: BASE,
      mergeable: true,
      mergeableState: "clean",
    },
    issueNumber: 12,
    issueLabels: [],
    sharedContextChanged: false,
    review: { state: "done", verdict: "lgtm" },
    ...overrides,
  };
}

describe("issueNumberFromHeadRef", () => {
  it("issue-<番号>だけを対応Issueとして読む", () => {
    expect(issueNumberFromHeadRef("issue-4114")).toBe(4114);
    expect(issueNumberFromHeadRef("pr-repair/4170-1")).toBeNull();
    expect(issueNumberFromHeadRef("issue-12-extra")).toBeNull();
  });
});

describe("decideBackupCiMerge", () => {
  it("合格・LGTM・コンフリクトなしなら、記録したheadを指定してマージする", () => {
    expect(decideBackupCiMerge(input())).toEqual({ kind: "merge", expectedHeadSha: HEAD });
  });

  it("レビューが無ければ積み、古いHEADとして取り消されていれば積み直す", () => {
    expect(decideBackupCiMerge(input({ review: { state: "missing" } })).kind).toBe("request_review");
    expect(decideBackupCiMerge(input({ review: { state: "stale" } })).kind).toBe("request_review");
  });

  it("レビュー待ちの間は待つ（Actionsの判定ジョブは待たない）", () => {
    expect(decideBackupCiMerge(input({ review: { state: "pending", phase: "running", host: "subpc" } })).kind).toBe("wait");
  });

  it("要修正・要確認は確認待ち（01.check-merge）、失敗は止まっている（01.check-blocked）", () => {
    const changes = decideBackupCiMerge(input({ review: { state: "done", verdict: "changes-requested" } }));
    expect(changes).toMatchObject({ kind: "hold", checkReason: "merge", notify: true });
    expect(decideBackupCiMerge(input({ review: { state: "done", verdict: "needs-check" } }))).toMatchObject({
      kind: "hold",
      checkReason: "merge",
    });
    expect(decideBackupCiMerge(input({ review: { state: "failed", reason: "時間切れ" } }))).toMatchObject({
      kind: "hold",
      checkReason: "blocked",
    });
  });

  it("22.merge-confirm-required・23.preview-requiredが付いていればレビュー前に止める", () => {
    for (const label of ["22.merge-confirm-required", "23.preview-required"]) {
      expect(decideBackupCiMerge(input({ issueLabels: [label], review: { state: "missing" } }))).toMatchObject({
        kind: "hold",
        checkReason: "merge",
      });
    }
  });

  it("既に00.check-userなら、ラベルもコメントも重ねずに止める", () => {
    expect(decideBackupCiMerge(input({ issueLabels: ["00.check-user"] }))).toMatchObject({
      kind: "hold",
      checkReason: null,
      notify: false,
    });
  });

  it("対応Issueが無いPRは自動マージしない（Actionsのauto-mergeと同じ）", () => {
    expect(decideBackupCiMerge(input({ issueNumber: null, issueLabels: null }))).toMatchObject({
      kind: "hold",
      checkReason: null,
      notify: true,
    });
  });

  it(".shared-context/の混入・コンフリクトでは止める", () => {
    expect(decideBackupCiMerge(input({ sharedContextChanged: true })).kind).toBe("hold");
    const pr = { ...input().pr, mergeable: false, mergeableState: "dirty" };
    expect(decideBackupCiMerge(input({ pr })).kind).toBe("hold");
  });

  it("マージ可否が計算中なら待つ", () => {
    const pr = { ...input().pr, mergeable: null, mergeableState: "unknown" };
    expect(decideBackupCiMerge(input({ pr })).kind).toBe("wait");
  });
});

describe("precheckBackupCiMerge", () => {
  it("合格していない・判定済みの実行には触れない", () => {
    expect(precheckBackupCiMerge(input({ run: { ...input().run, status: "running" } }))?.kind).toBe("ignore");
    expect(precheckBackupCiMerge(input({ run: { ...input().run, mergeStatus: "held" } }))?.kind).toBe("ignore");
    expect(precheckBackupCiMerge(input({ run: { ...input().run, mergeStatus: "reviewing" } }))).toBeNull();
  });

  it("head/baseが動いた合格は使わない", () => {
    const pr = { ...input().pr, headSha: "c".repeat(40) };
    expect(precheckBackupCiMerge(input({ pr }))).toMatchObject({ kind: "ignore" });
    const moved = { ...input().pr, baseSha: "c".repeat(40) };
    expect(precheckBackupCiMerge(input({ pr: moved }))).toMatchObject({ kind: "ignore" });
  });

  it("共通チェックがActionsの結果を採用したら、通常の経路に任せて対象から外す", () => {
    const gate = { ...input().gate!, source: "actions", sourceRef: "123:1" };
    expect(precheckBackupCiMerge(input({ gate }))).toMatchObject({ kind: "ignore", finalStatus: "skipped" });
  });

  it("共通チェックが別の試行・未反映・成功以外なら待つか外す", () => {
    expect(precheckBackupCiMerge(input({ gate: null }))?.kind).toBe("wait");
    const other = { ...input().gate!, sourceRef: "run0" };
    expect(precheckBackupCiMerge(input({ gate: other }))?.kind).toBe("ignore");
    const pending = { ...input().gate!, state: "pending" };
    expect(precheckBackupCiMerge(input({ gate: pending }))?.kind).toBe("wait");
  });

  it("マージ済み・クローズ済み・下書きは進めない", () => {
    expect(precheckBackupCiMerge(input({ pr: { ...input().pr, merged: true } }))).toMatchObject({
      kind: "ignore",
      finalStatus: "skipped",
    });
    expect(precheckBackupCiMerge(input({ pr: { ...input().pr, state: "closed" } }))?.kind).toBe("ignore");
    expect(precheckBackupCiMerge(input({ pr: { ...input().pr, draft: true } }))?.kind).toBe("wait");
  });
});
