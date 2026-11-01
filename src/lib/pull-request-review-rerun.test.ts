import { describe, expect, it } from "vitest";

import type { CiRerunRun } from "@/lib/pull-request-ci-rerun";
import { decideReviewRerun } from "@/lib/pull-request-review-rerun";

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
