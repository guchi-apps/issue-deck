import { describe, expect, it } from "vitest";

import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import { countReleaseActivity, describeReleaseActivity } from "@/lib/release-activity";

function makeReleaseStatus(
  repoFullName: string,
  status: RepositoryReleaseStatus["status"],
): RepositoryReleaseStatus {
  return {
    repoFullName,
    status,
    failedWorkflow: status === "error" ? "deploy" : null,
    pendingMerge:
      status === "action_required"
        ? {
            mergeTarget: "main",
            pullRequestNumber: 500,
            pullRequestUrl: `https://github.com/${repoFullName}/pull/500`,
            pullRequestTitle: "リリース v4.19.0",
            ciState: "success",
          }
        : null,
  };
}

describe("countReleaseActivity（#2167）", () => {
  it("未取得（null）のうちは件数を出さない（0件と区別する）", () => {
    expect(countReleaseActivity(null)).toBeNull();
  });

  it("動いているリポジトリが無ければ0件を返す", () => {
    expect(countReleaseActivity([])).toEqual({ total: 0, actionRequired: 0 });
  });

  it("返ってきたリポジトリ数がそのまま「リリース・デプロイ中」の件数になる", () => {
    const counts = countReleaseActivity([
      makeReleaseStatus("guchi-apps/issue-deck", "progressing"),
      makeReleaseStatus("guchi-apps/myroom", "progressing"),
    ]);

    expect(counts).toEqual({ total: 2, actionRequired: 0 });
  });

  it("マージ待ち（action_required）と失敗（error）を操作待ちに数える", () => {
    const counts = countReleaseActivity([
      makeReleaseStatus("guchi-apps/issue-deck", "action_required"),
      makeReleaseStatus("guchi-apps/myroom", "error"),
      makeReleaseStatus("guchi-apps/vps", "progressing"),
    ]);

    expect(counts).toEqual({ total: 3, actionRequired: 2 });
  });
});

describe("describeReleaseActivity（#2167）", () => {
  it("未取得・0件では動いているものが無いことを添える", () => {
    expect(describeReleaseActivity(null)).toContain("リリース・デプロイ中のプロジェクトはありません");
    expect(describeReleaseActivity({ total: 0, actionRequired: 0 })).toContain(
      "リリース・デプロイ中のプロジェクトはありません",
    );
  });

  it("操作待ちが無ければ件数だけを添える", () => {
    expect(describeReleaseActivity({ total: 3, actionRequired: 0 })).toContain(
      "リリース・デプロイ中3件",
    );
    expect(describeReleaseActivity({ total: 3, actionRequired: 0 })).not.toContain("操作待ち");
  });

  it("操作待ちがあれば内訳を添える", () => {
    expect(describeReleaseActivity({ total: 3, actionRequired: 1 })).toContain(
      "リリース・デプロイ中3件・うち操作待ち1件",
    );
  });
});
