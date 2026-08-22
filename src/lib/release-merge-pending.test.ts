import { describe, expect, it } from "vitest";

import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import {
  countReleaseMergePending,
  describeReleaseMergePending,
} from "@/lib/release-merge-pending";

function makeReleaseStatus(
  overrides: Partial<RepositoryReleaseStatus> = {},
): RepositoryReleaseStatus {
  return {
    repoFullName: "guchi-apps/issue-deck",
    status: "action_required",
    failedWorkflow: null,
    pendingMerge: {
      mergeTarget: "main",
      pullRequestNumber: 500,
      pullRequestUrl: "https://github.com/guchi-apps/issue-deck/pull/500",
      pullRequestTitle: "リリース v4.19.0",
      ciState: "success",
    },
    ...overrides,
  };
}

function makeDevelopPending(repoFullName: string): RepositoryReleaseStatus {
  return makeReleaseStatus({
    repoFullName,
    pendingMerge: {
      mergeTarget: "develop",
      pullRequestNumber: 12,
      pullRequestUrl: `https://github.com/${repoFullName}/pull/12`,
      pullRequestTitle: "v1.2.0をリリースする。",
      ciState: "success",
    },
  });
}

describe("countReleaseMergePending（#2055）", () => {
  it("未取得（null）と0件を区別する", () => {
    expect(countReleaseMergePending(null)).toBeNull();
    expect(countReleaseMergePending([])).toEqual({
      develop: 0,
      main: 0,
      total: 0,
      hasError: false,
    });
  });

  it("マージ先ごとに数え、合計を返す", () => {
    const counts = countReleaseMergePending([
      makeReleaseStatus(),
      makeReleaseStatus({ repoFullName: "guchi-apps/vps" }),
      makeDevelopPending("guchi-apps/portfolio"),
    ]);

    expect(counts).toEqual({ develop: 1, main: 2, total: 3, hasError: false });
  });

  it("マージ待ちが無いリポジトリ（進行中・失敗のみ）は数えない", () => {
    const counts = countReleaseMergePending([
      makeReleaseStatus({ status: "progressing", pendingMerge: null }),
      makeReleaseStatus({
        repoFullName: "guchi-apps/vps",
        status: "error",
        failedWorkflow: "deploy",
        pendingMerge: null,
      }),
    ]);

    expect(counts).toEqual({ develop: 0, main: 0, total: 0, hasError: false });
  });

  it("チェックが落ちているマージ待ちが1件でもあればhasErrorになる", () => {
    const counts = countReleaseMergePending([
      makeReleaseStatus(),
      makeReleaseStatus({
        repoFullName: "guchi-apps/vps",
        pendingMerge: { ...makeReleaseStatus().pendingMerge!, ciState: "failure" },
      }),
    ]);

    expect(counts?.hasError).toBe(true);
  });
});

describe("describeReleaseMergePending（#2055）", () => {
  it("0件・未取得は待ちが無いことを伝える", () => {
    expect(describeReleaseMergePending(null)).toBe("反映待ちはありません");
    expect(
      describeReleaseMergePending({ develop: 0, main: 0, total: 0, hasError: false }),
    ).toBe("反映待ちはありません");
  });

  it("0件の側は文言から落とす", () => {
    expect(
      describeReleaseMergePending({ develop: 0, main: 2, total: 2, hasError: false }),
    ).toBe("mainへマージ待ち2件");
    expect(
      describeReleaseMergePending({ develop: 1, main: 0, total: 1, hasError: false }),
    ).toBe("developへマージ待ち1件");
  });

  it("両方あるときはdevelop・mainの順で並べる", () => {
    expect(
      describeReleaseMergePending({ develop: 1, main: 2, total: 3, hasError: false }),
    ).toBe("developへマージ待ち1件・mainへマージ待ち2件");
  });
});
