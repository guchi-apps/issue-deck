import { describe, expect, it } from "vitest";

import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  resolvePlanReviewListState,
  selectPlanReviewCreatingIssueIds,
} from "@/lib/dispatch/plan-review-list-state";

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

  // 起動待ちは作成中と分ける（#3772）。猶予を超えても起動するまでは同じ表示
  it.each([
    ["積んだ直後", "2026-09-29T11:59:00Z"],
    ["10分を超えて待っている", "2026-09-29T07:00:00Z"],
  ])("起動待ちは%sでも起動待ち", (_label, createdAt) => {
    expect(
      resolvePlanReviewListState({
        ...base,
        jobs: [job({ status: "QUEUED", createdAt, finishedAt: null })],
        labels: planLabels,
      }),
    ).toBe("queued");
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

  it("猶予内でも、採否が決まっていれば提示済（#3648）", () => {
    expect(
      resolvePlanReviewListState({
        ...base,
        jobs: [job({ finishedAt: "2026-09-29T11:57:00Z", planReviewDecidedAt: "2026-09-29T11:59:00Z" })],
        labels: planLabels,
      }),
    ).toBe("presented");
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

describe("selectPlanReviewCreatingIssueIds", () => {
  it("作成中のIssueだけを返す", () => {
    const issues = [
      { id: "a", repositoryFullName: REPO, number: 1 },
      { id: "b", repositoryFullName: REPO, number: 2 },
    ];
    const jobs = [
      job({ issueNumber: 1, status: "RUNNING", finishedAt: null }),
      job({ issueNumber: 2, planReviewDecidedAt: "2026-09-29T11:02:00Z" }),
    ];
    expect([...selectPlanReviewCreatingIssueIds(issues, jobs, NOW)]).toEqual(["a"]);
  });

  // 起動待ちが10分を超えたら、確認待ちの一覧へ戻す（#3772）
  it("起動待ちは10分未満だけ返す", () => {
    const issues = [
      { id: "a", repositoryFullName: REPO, number: 1 },
      { id: "b", repositoryFullName: REPO, number: 2 },
    ];
    const jobs = [
      job({ issueNumber: 1, status: "QUEUED", createdAt: "2026-09-29T11:58:00Z", finishedAt: null }),
      job({ issueNumber: 2, status: "QUEUED", createdAt: "2026-09-29T07:00:00Z", finishedAt: null }),
    ];
    expect([...selectPlanReviewCreatingIssueIds(issues, jobs, NOW)]).toEqual(["a"]);
  });
});
