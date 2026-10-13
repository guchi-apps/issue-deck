import { describe, expect, it } from "vitest";

import { classifyUpdateBranch422, decideUpdateBranch, updateBranchErrorMessage } from "@/lib/pull-request-update-branch";

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

describe("classifyUpdateBranch422", () => {
  it("競合・SHA不一致・取り込み済みを見分ける", () => {
    expect(classifyUpdateBranch422("merge conflict between base and head")).toBe("conflict");
    expect(classifyUpdateBranch422("Head branch was modified. Review and try the merge again.")).toBe("head_changed");
    expect(classifyUpdateBranch422("There are no new commits on the base branch.")).toBe("already_up_to_date");
  });
  it("それ以外の422は分類しない（取り込み済みと誤表示しない）", () => {
    expect(classifyUpdateBranch422("Protected branch update failed")).toBeNull();
  });
});
