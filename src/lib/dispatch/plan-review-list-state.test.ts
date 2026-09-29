import { describe, expect, it } from "vitest";

import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import { resolvePlanReviewListState } from "@/lib/dispatch/plan-review-list-state";

const NOW = new Date("2026-09-29T12:00:00Z");
const REPO = "guchi-apps/issue-deck";
const planLabels = [{ name: "00.check-user" }, { name: "01.check-plan" }];

function job(overrides: Partial<DispatchJobView>): DispatchJobView {
  return {
    kind: "PLAN_REVIEW",
    repositoryFullName: REPO,
    issueNumber: 1,
    status: "SUCCEEDED",
    createdAt: "2026-09-29T11:00:00Z",
    finishedAt: "2026-09-29T11:01:00Z",
    ...overrides,
  } as DispatchJobView;
}

const base = { repositoryFullName: REPO, issueNumber: 1, now: NOW, planRequest: null };

describe("resolvePlanReviewListState", () => {
  it("ジョブが無ければnull", () => {
    expect(resolvePlanReviewListState({ ...base, jobs: [], labels: planLabels })).toBeNull();
  });

  it("実行中は作成中（ラベルに関係なく）", () => {
    expect(
      resolvePlanReviewListState({ ...base, jobs: [job({ status: "RUNNING", finishedAt: null })], labels: [] }),
    ).toBe("creating");
  });

  it("成功直後（猶予内）は作成中", () => {
    expect(
      resolvePlanReviewListState({
        ...base,
        jobs: [job({ finishedAt: "2026-09-29T11:57:00Z" })],
        labels: planLabels,
      }),
    ).toBe("creating");
  });

  it("猶予後で承認待ちなら提示済", () => {
    expect(resolvePlanReviewListState({ ...base, jobs: [job({})], labels: planLabels })).toBe("presented");
  });

  it("承認待ちでなければnull", () => {
    expect(resolvePlanReviewListState({ ...base, jobs: [job({})], labels: [] })).toBeNull();
  });

  it.each(["FAILED", "SKIPPED", "TIMEOUT", "CANCELED"] as const)("%sは提示済にしない", (status) => {
    expect(
      resolvePlanReviewListState({ ...base, jobs: [job({ status })], labels: planLabels }),
    ).toBeNull();
  });

  it("計画リクエストより古いジョブは提示済にしない", () => {
    expect(
      resolvePlanReviewListState({
        ...base,
        jobs: [job({})],
        planRequest: { createdAt: "2026-09-29T11:30:00Z" },
        labels: planLabels,
      }),
    ).toBeNull();
  });

  it("計画リクエストが消えていれば（期限切れ後）ジョブの存在だけで提示済", () => {
    expect(resolvePlanReviewListState({ ...base, jobs: [job({})], labels: planLabels })).toBe("presented");
  });
});
