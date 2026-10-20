import { describe, expect, it } from "vitest";

import { requiredCheckNamesOf, unmetRequiredChecks } from "@/lib/github/required-checks";

describe("requiredCheckNamesOf", () => {
  it("ルールセットとブランチ保護の両方から重複なしで集める", () => {
    expect(
      requiredCheckNamesOf(
        [
          { type: "pull_request" },
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "issue-deck/ci-gate" }, { context: "issue-deck/ios-precheck" }] },
          },
        ],
        { protection: { required_status_checks: { contexts: ["issue-deck/ci-gate"], checks: [{ context: "ci / test" }] } } },
      ),
    ).toEqual(["issue-deck/ci-gate", "issue-deck/ios-precheck", "ci / test"]);
  });

  it("ルール・保護が無ければ空", () => {
    expect(requiredCheckNamesOf(null, null)).toEqual([]);
    expect(requiredCheckNamesOf([], { protection: null })).toEqual([]);
  });
});

describe("unmetRequiredChecks", () => {
  it("待機中のcommit statusはdescriptionつきで返し、成功したものは外す（yoteiflow#1284）", () => {
    expect(
      unmetRequiredChecks(
        ["issue-deck/ci-gate", "issue-deck/ios-precheck"],
        [
          { __typename: "StatusContext", context: "issue-deck/ci-gate", state: "SUCCESS" },
          { __typename: "StatusContext", context: "issue-deck/ios-precheck", state: "PENDING", description: "iOS修復待ち" },
        ],
      ),
    ).toEqual([{ name: "issue-deck/ios-precheck", state: "pending", description: "iOS修復待ち" }]);
  });

  it("check-runは実行中・失敗・未実行を区別し、走り直して成功した古い失敗は数えない", () => {
    expect(
      unmetRequiredChecks(
        ["running", "failed", "absent", "rerun"],
        [
          { __typename: "CheckRun", name: "running", status: "IN_PROGRESS", conclusion: null },
          { __typename: "CheckRun", name: "failed", status: "COMPLETED", conclusion: "FAILURE" },
          {
            __typename: "CheckRun",
            name: "rerun",
            status: "COMPLETED",
            conclusion: "FAILURE",
            startedAt: "2026-10-19T00:00:00Z",
            completedAt: "2026-10-19T00:05:00Z",
          },
          {
            __typename: "CheckRun",
            name: "rerun",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            startedAt: "2026-10-19T00:10:00Z",
            completedAt: "2026-10-19T00:15:00Z",
          },
        ],
      ),
    ).toEqual([
      { name: "running", state: "pending", description: null },
      { name: "failed", state: "failure", description: null },
      { name: "absent", state: "missing", description: null },
    ]);
  });
});
