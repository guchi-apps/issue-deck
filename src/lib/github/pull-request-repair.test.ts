import { describe, expect, it } from "vitest";

import {
  CI_FIX_WORKFLOW_FILE,
  CONFLICT_RESOLVE_WORKFLOW_FILE,
  PR_REPAIR_WORKFLOW_FILE,
  canRepairFromDeck,
  repairKindsFor,
  resolveRepairDispatch,
} from "@/lib/github/pull-request-repair";

describe("resolveRepairDispatch", () => {
  it("develop向けのissue-<番号>PRは既存のCI失敗修正ワークフローへIssue番号を渡す", () => {
    expect(
      resolveRepairDispatch({ number: 42, baseRef: "develop", headRef: "issue-123" }, "ci"),
    ).toEqual({
      workflowFile: CI_FIX_WORKFLOW_FILE,
      ref: "develop",
      inputs: { issue_number: "123" },
    });
  });

  it("develop向けのissue-<番号>PRは既存のコンフリクト解消ワークフローへIssue番号を渡す", () => {
    expect(
      resolveRepairDispatch({ number: 42, baseRef: "develop", headRef: "issue-123" }, "conflict"),
    ).toEqual({
      workflowFile: CONFLICT_RESOLVE_WORKFLOW_FILE,
      ref: "develop",
      inputs: { issue_number: "123" },
    });
  });

  it("develop→mainのリリースPRはIssueに紐づかないためPR番号を渡す", () => {
    expect(
      resolveRepairDispatch({ number: 900, baseRef: "main", headRef: "develop" }, "ci"),
    ).toEqual({
      workflowFile: PR_REPAIR_WORKFLOW_FILE,
      ref: "develop",
      inputs: { pr_number: "900", mode: "ci" },
    });
  });

  it("バンプPRもIssueに紐づかないためPR番号を渡す", () => {
    expect(
      resolveRepairDispatch({ number: 901, baseRef: "develop", headRef: "release/v1.2.3" }, "conflict"),
    ).toEqual({
      workflowFile: PR_REPAIR_WORKFLOW_FILE,
      ref: "develop",
      inputs: { pr_number: "901", mode: "conflict" },
    });
  });

  it("issue-<番号>ブランチでもbaseがdevelopでなければ既存ワークフローの対象外", () => {
    // 既存ワークフローはdevelop向けPRしか探さないため、渡しても何もせず終わる。
    expect(
      resolveRepairDispatch({ number: 902, baseRef: "main", headRef: "issue-123" }, "ci"),
    ).toEqual({
      workflowFile: PR_REPAIR_WORKFLOW_FILE,
      ref: "develop",
      inputs: { pr_number: "902", mode: "ci" },
    });
  });
});

describe("canRepairFromDeck", () => {
  it("openかつdraftでないPRだけが対象", () => {
    expect(canRepairFromDeck({ state: "open", draft: false })).toBe(true);
    expect(canRepairFromDeck({ state: "open", draft: true })).toBe(false);
    expect(canRepairFromDeck({ state: "closed", draft: false })).toBe(false);
  });
});

describe("repairKindsFor", () => {
  const open = { state: "open", draft: false } as const;

  it("CI失敗のみならCIの1種類", () => {
    expect(repairKindsFor({ ...open, ciState: "failure" }, true)).toEqual(["ci"]);
  });

  it("コンフリクトのみならコンフリクトの1種類", () => {
    expect(repairKindsFor({ ...open, ciState: "success" }, false)).toEqual(["conflict"]);
  });

  it("両方あるときはコンフリクトを先に出す", () => {
    // developを取り込まないままCIを直しても再度CIが走るため、先に解消させたい。
    expect(repairKindsFor({ ...open, ciState: "failure" }, false)).toEqual(["conflict", "ci"]);
  });

  it("mergeableが判定中（null）の間はコンフリクトのボタンを出さない", () => {
    expect(repairKindsFor({ ...open, ciState: "success" }, null)).toEqual([]);
    expect(repairKindsFor({ ...open, ciState: "success" }, undefined)).toEqual([]);
  });

  it("CIが実行中・不明・成功のときはCIのボタンを出さない", () => {
    expect(repairKindsFor({ ...open, ciState: "pending" }, true)).toEqual([]);
    expect(repairKindsFor({ ...open, ciState: "unknown" }, true)).toEqual([]);
    expect(repairKindsFor({ ...open, ciState: null }, true)).toEqual([]);
  });

  it("draft・closedのPRでは何も出さない", () => {
    expect(repairKindsFor({ state: "open", draft: true, ciState: "failure" }, false)).toEqual([]);
    expect(repairKindsFor({ state: "closed", draft: false, ciState: "failure" }, false)).toEqual([]);
  });
});
