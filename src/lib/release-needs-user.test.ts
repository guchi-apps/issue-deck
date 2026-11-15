import { describe, expect, it } from "vitest";

import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import { countReleaseNeedsUser, describeReleaseNeedsUser } from "@/lib/release-needs-user";

function status(overrides: Partial<RepositoryReleaseStatus>): RepositoryReleaseStatus {
  return {
    repoFullName: "o/r",
    status: "progressing",
    failedWorkflow: null,
    pendingMerge: null,
    ...overrides,
  };
}

describe("countReleaseNeedsUser", () => {
  it("未取得はnull、needsUserが真のリポジトリだけを数える", () => {
    expect(countReleaseNeedsUser(null)).toBeNull();
    expect(
      countReleaseNeedsUser([
        status({ needsUser: true }),
        status({ needsUser: true, failedWorkflow: "deploy", status: "error" }),
        status({ needsUser: false }),
        status({}),
      ]),
    ).toEqual({ total: 2, deployFailed: 1 });
  });
});

describe("describeReleaseNeedsUser", () => {
  it("内訳を書き分け、0件・未取得は無しと読める", () => {
    expect(describeReleaseNeedsUser({ total: 3, deployFailed: 1 })).toBe(
      "承認・判断・マージ待ち2件・デプロイ失敗1件",
    );
    expect(describeReleaseNeedsUser(null)).toBe("手が要るものはありません");
  });
});
