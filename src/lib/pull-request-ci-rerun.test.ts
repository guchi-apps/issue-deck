import { describe, expect, it } from "vitest";

import { decideCiRerun, selectCiRuns, type CiRerunRun } from "@/lib/pull-request-ci-rerun";

const run = (over: Partial<CiRerunRun>): CiRerunRun => ({
  id: 1,
  name: "CI",
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  headSha: "aaa",
  event: "pull_request",
  htmlUrl: null,
  ...over,
});
const pr = { state: "open", merged: false, headSha: "aaa" };

describe("selectCiRuns", () => {
  it("古いSHA・運用自動化・デプロイ・pull_request以外を除く", () => {
    const runs = [
      run({ id: 1 }),
      run({ id: 2, headSha: "old" }),
      run({ id: 3, path: ".github/workflows/claude-review-develop.yml@refs/heads/x" }),
      run({ id: 4, path: ".github/workflows/deploy.yml" }),
      run({ id: 5, event: "push" }),
    ];
    expect(selectCiRuns(runs, "aaa").map((r) => r.id)).toEqual([1]);
  });
});

describe("decideCiRerun", () => {
  it("失敗分は失敗・キャンセルのrunだけ", () => {
    const runs = [run({ id: 1 }), run({ id: 2, conclusion: "failure" }), run({ id: 3, conclusion: "cancelled" })];
    expect(decideCiRerun(pr, "aaa", runs, "failed")).toEqual({ action: "rerun", scope: "failed", runIds: [2, 3] });
  });
  it("全体は成功済みも含む", () => {
    expect(decideCiRerun(pr, "aaa", [run({ id: 1 })], "all")).toMatchObject({ runIds: [1] });
  });
  it("失敗が無ければ失敗分は断る", () => {
    expect(decideCiRerun(pr, "aaa", [run({})], "failed")).toEqual({ action: "reject", code: "nothing_failed" });
  });
  it("実行記録なし・実行中・head変更を断る", () => {
    expect(decideCiRerun(pr, "aaa", [], "all")).toMatchObject({ code: "no_run" });
    expect(decideCiRerun(pr, "aaa", [run({ status: "in_progress", conclusion: null })], "all")).toMatchObject({
      code: "in_progress",
    });
    expect(decideCiRerun(pr, "bbb", [run({})], "all")).toMatchObject({ code: "head_changed" });
  });
  it("古いSHAのrunしか無ければno_run", () => {
    expect(decideCiRerun(pr, "aaa", [run({ headSha: "old" })], "all")).toMatchObject({ code: "no_run" });
  });
});
