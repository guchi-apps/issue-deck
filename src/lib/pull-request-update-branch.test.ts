import { describe, expect, it } from "vitest";

import { decideUpdateBranch, updateBranchErrorMessage } from "@/lib/pull-request-update-branch";

const base = {
  state: "open",
  merged: false,
  baseRef: "develop",
  headRef: "issue-1",
  headSha: "aaa",
  headRepoFullName: "o/r",
  baseRepoFullName: "o/r",
  mergeableState: "behind",
};

describe("decideUpdateBranch", () => {
  it("behindの通常PRは取り込める", () => {
    expect(decideUpdateBranch(base, "aaa")).toEqual({ action: "update" });
  });
  it("期待したheadと違えば更新しない", () => {
    expect(decideUpdateBranch(base, "bbb")).toEqual({ action: "reject", code: "head_changed" });
  });
  it("クローズ済み・マージ済みは断る", () => {
    expect(decideUpdateBranch({ ...base, state: "closed" }, "aaa")).toMatchObject({ code: "pull_request_not_open" });
    expect(decideUpdateBranch({ ...base, merged: true }, "aaa")).toMatchObject({ code: "pull_request_not_open" });
  });
  it("リリースPR・フォーク・競合は断る", () => {
    expect(decideUpdateBranch({ ...base, baseRef: "main", headRef: "develop" }, "aaa")).toMatchObject({
      code: "release_pull_request",
    });
    expect(decideUpdateBranch({ ...base, headRepoFullName: "x/r" }, "aaa")).toMatchObject({ code: "fork_not_updatable" });
    expect(decideUpdateBranch({ ...base, mergeableState: "dirty" }, "aaa")).toMatchObject({ code: "conflict" });
  });
  it("実際のbase名を文言に使う", () => {
    expect(updateBranchErrorMessage("conflict", "develop")).toContain("develop");
  });
});
