import { describe, expect, it } from "vitest";

import { digestDefinition, verifyCircleciSignature } from "@/lib/backup-ci/crypto";
import {
  buildBackupCiActiveKey,
  decideCiGateFromBackupRun,
  evaluateBackupCiResult,
  expandRequiredChecks,
  parseCircleciWebhook,
} from "@/lib/backup-ci/state";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const manifest = {
  schemaVersion: 1,
  groups: {
    "lint-and-build": { checks: [{ id: "lint", name: "Lint", run: "pnpm lint" }] },
    "docs-sync-check": { checks: [{ id: "workflow-gh-repo", name: "Workflow gh", run: "scripts/x.sh" }] },
  },
};
const expected = expandRequiredChecks(manifest)!;
const run = { id: "run1", headSha: HEAD, baseSha: BASE, definitionDigest: "sha256:def" };

function result(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    definitionDigest: "sha256:def",
    requestedHeadSha: HEAD,
    requestedBaseSha: BASE,
    runRequestId: "run1",
    testedSha: "c".repeat(40),
    testedParents: [BASE, HEAD],
    checks: [
      { group: "lint-and-build", id: "lint", status: "passed" },
      { group: "docs-sync-check", id: "workflow-gh-repo", status: "passed" },
    ],
    ...overrides,
  };
}

describe("expandRequiredChecks", () => {
  it("実際の定義（ci/required-checks.json）を展開でき、lint以外の同期・workflow検査も含む", () => {
    const checks = expandRequiredChecks(JSON.parse(readFileSync("ci/required-checks.json", "utf8")))!;
    const ids = checks.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["lint", "typecheck", "unit-tests", "build", "workflow-job-permissions", "workflow-expression-syntax", "ci-definition-sync"]));
  });

  it("形が崩れた定義・空のグループはnull（検査0件で合格にしない）", () => {
    expect(expandRequiredChecks(null)).toBeNull();
    expect(expandRequiredChecks({ schemaVersion: 2, groups: {} })).toBeNull();
    expect(expandRequiredChecks({ schemaVersion: 1, groups: {} })).toBeNull();
    expect(expandRequiredChecks({ schemaVersion: 1, groups: { a: { checks: [] } } })).toBeNull();
  });
});

describe("evaluateBackupCiResult", () => {
  it("全部通り、記録と一致すれば合格", () => {
    const v = evaluateBackupCiResult({ run, expectedChecks: expected, jobSucceeded: true, result: result() });
    expect(v.status).toBe("passed");
  });

  it("同期・workflow関連の検査の失敗でも不合格", () => {
    const v = evaluateBackupCiResult({
      run,
      expectedChecks: expected,
      jobSucceeded: false,
      result: result({
        checks: [
          { group: "lint-and-build", id: "lint", status: "passed" },
          { group: "docs-sync-check", id: "workflow-gh-repo", status: "failed" },
        ],
      }),
    });
    expect(v.status).toBe("failed");
  });

  it("検査の欠落は、ジョブが成功でも合格にしない", () => {
    const v = evaluateBackupCiResult({
      run,
      expectedChecks: expected,
      jobSucceeded: true,
      result: result({ checks: [{ group: "lint-and-build", id: "lint", status: "passed" }] }),
    });
    expect(v.status).toBe("invalid");
  });

  it.each([
    ["検査定義の不一致", { definitionDigest: "sha256:other" }],
    ["head不一致", { requestedHeadSha: "d".repeat(40) }],
    ["base不一致", { requestedBaseSha: "d".repeat(40) }],
    ["別の実行の結果", { runRequestId: "run2" }],
    ["headだけを検査（マージ結果でない）", { testedParents: [HEAD] }],
  ])("%sは不合格", (_label, overrides) => {
    const v = evaluateBackupCiResult({ run, expectedChecks: expected, jobSucceeded: true, result: result(overrides) });
    expect(v.status).toBe("invalid");
  });

  it("結果が取れない成功は不合格、結果が出る前の失敗は失敗", () => {
    expect(evaluateBackupCiResult({ run, expectedChecks: expected, jobSucceeded: true, result: null }).status).toBe("invalid");
    expect(evaluateBackupCiResult({ run, expectedChecks: expected, jobSucceeded: false, result: null }).status).toBe("failed");
  });

  it("起動時に定義のダイジェストを記録していなければ合格にしない", () => {
    const v = evaluateBackupCiResult({
      run: { ...run, definitionDigest: null },
      expectedChecks: expected,
      jobSucceeded: true,
      result: result(),
    });
    expect(v.status).toBe("invalid");
  });
});

describe("decideCiGateFromBackupRun", () => {
  const base = { headSha: HEAD, baseSha: BASE, statusReason: null };
  it("現在のhead/baseに対する合格だけがsuccess", () => {
    expect(decideCiGateFromBackupRun({ ...base, status: "passed" }, { headSha: HEAD, baseSha: BASE }).state).toBe("success");
    expect(decideCiGateFromBackupRun({ ...base, status: "passed" }, { headSha: HEAD, baseSha: "e".repeat(40) }).state).toBe("pending");
    expect(decideCiGateFromBackupRun({ ...base, status: "passed" }, { headSha: "e".repeat(40), baseSha: BASE }).state).toBe("pending");
  });

  it.each(["unverifiable", "trigger_unknown", "trigger_failed"] as const)("%sは成功にしない", (status) => {
    expect(decideCiGateFromBackupRun({ ...base, status }, { headSha: HEAD, baseSha: BASE }).state).toBe("error");
  });

  it("失敗・不一致はfailure、実行中はpending", () => {
    expect(decideCiGateFromBackupRun({ ...base, status: "failed" }, { headSha: HEAD, baseSha: BASE }).state).toBe("failure");
    expect(decideCiGateFromBackupRun({ ...base, status: "invalid" }, { headSha: HEAD, baseSha: BASE }).state).toBe("failure");
    expect(decideCiGateFromBackupRun({ ...base, status: "running" }, { headSha: HEAD, baseSha: BASE }).state).toBe("pending");
  });
});

describe("Webhook", () => {
  const body = JSON.stringify({ id: "evt-1", type: "workflow-completed", pipeline: { id: "p1" }, workflow: { id: "w1", status: "success" } });
  const sig = createHmac("sha256", "secret").update(body).digest("hex");

  it("正しい署名だけを通す", () => {
    expect(verifyCircleciSignature(body, `v1=${sig}`, "secret")).toBe(true);
    expect(verifyCircleciSignature(body, `v0=zzz, v1=${sig}`, "secret")).toBe(true);
    expect(verifyCircleciSignature(body, `v1=${sig}`, "other")).toBe(false);
    expect(verifyCircleciSignature(`${body} `, `v1=${sig}`, "secret")).toBe(false);
    expect(verifyCircleciSignature(body, null, "secret")).toBe(false);
    expect(verifyCircleciSignature(body, `v1=${sig}`, "")).toBe(false);
  });

  it("イベントIDとパイプラインIDを取り出す", () => {
    expect(parseCircleciWebhook(JSON.parse(body))).toMatchObject({ eventId: "evt-1", pipelineId: "p1", workflowStatus: "success" });
    expect(parseCircleciWebhook({ type: "x" })).toBeNull();
  });
});

describe("digestDefinition", () => {
  it("ランナー（scripts/ci/run-required-checks.mjs）と同じ値になる", async () => {
    const runner = await import("../../../scripts/ci/run-required-checks.mjs");
    const raw = readFileSync("ci/required-checks.json");
    expect(digestDefinition(raw)).toBe(runner.digestDefinition(raw));
  });
});

describe("buildBackupCiActiveKey", () => {
  it("PR単位で1つ", () => {
    expect(buildBackupCiActiveKey("o/r", 1)).toBe("backup_ci:o/r#1");
  });
});
