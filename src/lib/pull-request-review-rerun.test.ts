import { describe, expect, it } from "vitest";

import type { CiRerunRun } from "@/lib/pull-request-ci-rerun";
import { decideReviewRerun, decideReviewRestart, isWorkflowRunRetryRefused } from "@/lib/pull-request-review-rerun";

const run = (over: Partial<CiRerunRun>): CiRerunRun => ({
  id: 1,
  name: "Claude Review (develop)",
  path: ".github/workflows/claude-review-develop.yml",
  status: "completed",
  conclusion: "success",
  headSha: "aaa",
  event: "pull_request",
  htmlUrl: null,
  ...over,
});
const pr = { state: "open", merged: false, baseRef: "develop", headSha: "aaa" };

describe("decideReviewRerun", () => {
  it("現在のHEADのAIレビューのrunのうち最新を再実行する", () => {
    const runs = [
      run({ id: 1 }),
      run({ id: 3 }),
      run({ id: 9, path: ".github/workflows/ci.yml" }),
      run({ id: 10, headSha: "old" }),
      run({ id: 11, event: "push" }),
    ];
    expect(decideReviewRerun(pr, "aaa", runs)).toEqual({ action: "rerun", runId: 3 });
  });

  it("ref付きのpathでもworkflowファイル名で判定する", () => {
    const runs = [run({ id: 4, path: ".github/workflows/claude-review-develop.yml@refs/heads/issue-1" })];
    expect(decideReviewRerun(pr, "aaa", runs)).toEqual({ action: "rerun", runId: 4 });
  });

  it("閉じた・マージ済み・develop以外・HEADが変わったPRは断る", () => {
    expect(decideReviewRerun({ ...pr, state: "closed" }, "aaa", [run({})])).toMatchObject({ code: "pull_request_not_open" });
    expect(decideReviewRerun({ ...pr, merged: true }, "aaa", [run({})])).toMatchObject({ code: "pull_request_not_open" });
    expect(decideReviewRerun({ ...pr, baseRef: "main" }, "aaa", [run({})])).toMatchObject({ code: "not_develop" });
    expect(decideReviewRerun(pr, "bbb", [run({})])).toMatchObject({ code: "head_changed" });
  });

  it("対象runが無い・実行中なら断る", () => {
    expect(decideReviewRerun(pr, "aaa", [run({ path: ".github/workflows/ci.yml" })])).toMatchObject({ code: "no_run" });
    expect(decideReviewRerun(pr, "aaa", [run({ id: 1 }), run({ id: 2, status: "in_progress", conclusion: null })])).toMatchObject({
      code: "in_progress",
    });
  });
});

describe("isWorkflowRunRetryRefused", () => {
  it("再実行の拒否だけを拾い、権限不足の403とは分ける", () => {
    expect(isWorkflowRunRetryRefused(403, '{"message":"This workflow run cannot be retried"}')).toBe(true);
    expect(isWorkflowRunRetryRefused(403, "Unable to retry this workflow run")).toBe(true);
    expect(isWorkflowRunRetryRefused(403, "Resource not accessible by integration")).toBe(false);
    expect(isWorkflowRunRetryRefused(500, "cannot be retried")).toBe(false);
  });
});

describe("decideReviewRestart", () => {
  const current = { state: "open", merged: false, draft: false, baseRef: "develop", headSha: "aaa", nodeId: "PR_1" };

  it("開いているdevelop向けで、HEADが同じならPRのNode IDで起動する", () => {
    expect(decideReviewRestart(current, "aaa")).toEqual({ action: "restart", nodeId: "PR_1" });
  });

  it("下書きへ戻す前に、状態が変わったPRと元から下書きのPRを断る", () => {
    expect(decideReviewRestart({ ...current, merged: true }, "aaa")).toMatchObject({ code: "pull_request_not_open" });
    expect(decideReviewRestart({ ...current, state: "closed" }, "aaa")).toMatchObject({ code: "pull_request_not_open" });
    expect(decideReviewRestart({ ...current, baseRef: "main" }, "aaa")).toMatchObject({ code: "not_develop" });
    expect(decideReviewRestart(current, "bbb")).toMatchObject({ code: "head_changed" });
    expect(decideReviewRestart({ ...current, draft: true }, "aaa")).toMatchObject({ code: "draft" });
    expect(decideReviewRestart({ ...current, nodeId: null }, "aaa")).toMatchObject({ code: "restart_failed" });
  });
});
