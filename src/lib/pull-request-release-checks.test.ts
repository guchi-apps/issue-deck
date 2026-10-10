import { describe, expect, it } from "vitest";

import { summarizeReleaseChecks } from "@/lib/pull-request-release-checks";

const current = { baseSha: "b1", headSha: "h1" };

describe("summarizeReleaseChecks", () => {
  it("記録が無ければ両方とも未実施になる", () => {
    expect(summarizeReleaseChecks(current, [])).toEqual({ aiReview: "not_run", integration: "not_run" });
  });

  it("現在のSHAの結果を区分ごとに返し、待機中は実行中へ畳む", () => {
    expect(
      summarizeReleaseChecks(current, [
        { kind: "ai_review", state: "passed", baseSha: "b1", headSha: "h1" },
        { kind: "integration", state: "waiting", baseSha: "b1", headSha: "h1" },
      ]),
    ).toEqual({ aiReview: "passed", integration: "running" });
  });

  it("対象が変わった古い結果は無効扱いにし、成功と見せない", () => {
    expect(
      summarizeReleaseChecks(current, [{ kind: "integration", state: "passed", baseSha: "b0", headSha: "h0" }]),
    ).toEqual({ aiReview: "not_run", integration: "invalidated" });
  });
});
