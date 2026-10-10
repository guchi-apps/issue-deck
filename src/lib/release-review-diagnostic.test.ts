import { describe, expect, it } from "vitest";

import {
  buildDiagnosticExcerpt,
  describeReleaseReviewDiagnostic,
  normalizeReleaseReviewDiagnostic,
  readReleaseReviewDiagnostic,
  redactDiagnosticText,
} from "./release-review-diagnostic";

const target = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };

describe("redactDiagnosticText", () => {
  it("トークン・Bearer・op参照・URLの認証情報を伏せる", () => {
    const text = [
      "Authorization: Bearer abcdef1234567890",
      "GITHUB_TOKEN=ghp_abcdefghijklmnop",
      "https://user:pw@example.com/x",
      "op://vault/item/field",
      "sk-ant-abcdefghijkl",
    ].join("\n");
    const out = redactDiagnosticText(text);
    expect(out).not.toMatch(/abcdef1234567890|ghp_|user:pw|vault\/item|sk-ant-/);
  });

  it("通常のエラー文は残す", () => {
    expect(redactDiagnosticText("claude: command not found")).toBe("claude: command not found");
  });
});

describe("buildDiagnosticExcerpt", () => {
  it("末尾の行・長さだけを残し、空はnull", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const out = buildDiagnosticExcerpt(lines);
    expect(out).toContain("line99");
    expect(out).not.toContain("line10\n");
    expect(buildDiagnosticExcerpt("   ")).toBeNull();
    expect(buildDiagnosticExcerpt("x".repeat(5000))!.length).toBeLessThanOrEqual(2001);
  });
});

describe("normalizeReleaseReviewDiagnostic", () => {
  it("対象SHAはジョブ側の値で決め、報告の本文のSHAは使わない", () => {
    const d = normalizeReleaseReviewDiagnostic(
      { cause: "timeout", stage: "review", exitCode: 124, targetHeadSha: "evil" },
      target,
    );
    expect(d).toMatchObject({ cause: "timeout", stage: "review", exitCode: 124, targetHeadSha: target.headSha });
  });

  it("知らない原因・工程は原因未特定・工程なしに落とす", () => {
    expect(normalizeReleaseReviewDiagnostic({ cause: "weird", stage: "x" }, target)).toMatchObject({
      cause: "unknown",
      stage: null,
    });
    expect(normalizeReleaseReviewDiagnostic("x", target)).toBeNull();
  });
});

describe("readReleaseReviewDiagnostic", () => {
  it("現在の対象と違う診断は返さない（旧実行の原因を現在の結果に見せない）", () => {
    const d = normalizeReleaseReviewDiagnostic({ cause: "auth_failed" }, target);
    expect(readReleaseReviewDiagnostic({ diagnostic: d }, target)?.cause).toBe("auth_failed");
    expect(readReleaseReviewDiagnostic({ diagnostic: d }, { ...target, headSha: "c".repeat(40) })).toBeNull();
    expect(readReleaseReviewDiagnostic(null, target)).toBeNull();
  });
});

describe("describeReleaseReviewDiagnostic", () => {
  it("診断が無ければ原因未特定として扱い、権限などを断定しない", () => {
    const v = describeReleaseReviewDiagnostic(null);
    expect(v.unidentified).toBe(true);
    expect(v.causeLabel).not.toMatch(/権限/);
  });

  it("起動失敗は原因の細目を断定しない", () => {
    const v = describeReleaseReviewDiagnostic(normalizeReleaseReviewDiagnostic({ cause: "launch_failed", stage: "review" }, target));
    expect(v.stageLabel).toBe("AIレビュー");
    expect(v.unidentified).toBe(false);
  });
});
