import { describe, expect, it } from "vitest";
import { buildBranchFlow } from "@/lib/branch-flow";
import { describeBranchFlow } from "./branch-flow-guidance";

function fixture() {
  const repo = buildBranchFlow({ repositories: [{ fullName: "owner/app", private: false }], pullRequests: [], issues: [], branchStatuses: [] }).repositories[0];
  repo.branchesLoaded = true;
  repo.release.comparison = { aheadBy: 0, behindBy: 0, sameContent: true, units: null };
  return repo;
}
const options = { branchesFailed: false, releaseLaunching: false, verification: null, unreleasedCount: 0 };

describe("ブランチの現在地と次の操作", () => {
  it("未取得を変更なしと案内しない", () => {
    const repo = fixture(); repo.branchesLoaded = false;
    expect(describeBranchFlow(repo, options)).toMatchObject({ state: "状態未取得", attention: false, loading: true });
  });
  it("取得失敗は取得中と区別して警告のままにする", () => {
    const repo = fixture(); repo.branchesLoaded = false;
    expect(describeBranchFlow(repo, { ...options, branchesFailed: true })).toMatchObject({ attention: true });
    expect(describeBranchFlow(repo, { ...options, branchesFailed: true }).loading).toBeFalsy();
  });
  it("再取得失敗時は古い変更数で公開を案内しない", () => {
    expect(describeBranchFlow(fixture(), { ...options, branchesFailed: true, unreleasedCount: 3 }).next).toBe("取得状況を確認");
  });
  it("同時に検証中でも失敗を優先する", () => {
    const verification = { problem: { kind: "failed" as const, label: "検証失敗", reasons: ["build failed"] }, progress: { label: "レビュー中", checks: [] }, detail: null };
    expect(describeBranchFlow(fixture(), { ...options, verification }).state).toBe("検証失敗");
  });
  it("デプロイ失敗を公開前変更で覆わない", () => {
    const repo = fixture(); repo.summary.deploy = { kind: "failure", htmlUrl: null, runId: null, manual: false, autoRetried: false };
    expect(describeBranchFlow(repo, { ...options, unreleasedCount: 2 }).state).toBe("デプロイ失敗");
  });
  it("実行中と手作業を区別し、操作不要と断定しない", () => {
    const repo = fixture(); repo.summary.releaseInProgress = true;
    expect(describeBranchFlow(repo, options)).toMatchObject({ attention: false, state: "リリース処理中" });
    repo.summary.releaseInProgress = false; repo.summary.openManualStepCount = 1;
    expect(describeBranchFlow(repo, options).attention).toBe(true);
  });
  it("RC未作成の変更と開発中を区別する", () => {
    const repo = fixture(); repo.summary.activeLaneCount = 1;
    expect(describeBranchFlow(repo, options).state).toBe("開発中");
    expect(describeBranchFlow(repo, { ...options, unreleasedCount: 1 }).next).toBe("公開する変更を見る");
  });
  it("変更がない場合も本番正常と断定しない", () => {
    expect(describeBranchFlow(fixture(), options).state).toBe("公開前の変更なし");
  });
});
