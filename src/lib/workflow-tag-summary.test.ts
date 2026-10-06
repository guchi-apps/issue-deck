import { describe, expect, it } from "vitest";

import { summarizeWorkflowTags } from "@/lib/workflow-tag-summary";
import type { PropagationRun, SourceAhead, WorkflowTagStatus } from "@/lib/workflow-tags";
import type { WorkflowTagsOverview } from "@/lib/workflow-tags-store";

function status(fullName: string, overrides: Partial<WorkflowTagStatus> = {}): WorkflowTagStatus {
  return {
    fullName,
    refs: [],
    outdated: false,
    mismatched: false,
    updatePullRequest: null,
    missingRepairWorkflows: [],
    brokenRepairWorkflows: [],
    repairPullRequest: null,
    outdatedSharedFiles: [],
    missingReleaseWebhookWorkflows: [],
    customizedSharedFiles: [],
    sharedFilePullRequest: null,
    ...overrides,
  };
}

const sameContent: SourceAhead = {
  tag: "workflows/v5",
  aheadBy: 40,
  compareUrl: "https://example.test",
  hasContentDiff: false,
  changedFiles: [],
  changeReasons: [],
};

const running: PropagationRun = {
  status: "in_progress",
  conclusion: null,
  htmlUrl: "https://example.test/run",
  createdAt: "2026-10-05T00:00:00Z",
};

function overview(overrides: Partial<WorkflowTagsOverview> = {}): WorkflowTagsOverview {
  return {
    latest: "workflows/v5",
    repositories: [],
    propagation: null,
    repairPropagation: null,
    sharedFilePropagation: null,
    sourceAhead: sameContent,
    unverifiedRepositories: [],
    ...overrides,
  };
}

const labels = (input: Parameters<typeof summarizeWorkflowTags>[0]) =>
  summarizeWorkflowTags(input).parts.map((part) => part.label);

describe("summarizeWorkflowTags", () => {
  it("未取得は確認中、失敗は確認できません", () => {
    expect(labels({ overview: null, failed: false })).toEqual(["確認中"]);
    expect(labels({ overview: null, failed: true })).toEqual(["確認できません"]);
  });

  it("差分なし・対象なしは最新", () => {
    expect(labels({ overview: overview(), failed: false })).toEqual(["最新"]);
  });

  it("配布対象に差分があれば公開・配布が必要。無関係な差分（hasContentDiff=false）では促さない", () => {
    expect(
      labels({
        overview: overview({ sourceAhead: { ...sameContent, hasContentDiff: true } }),
        failed: false,
      }),
    ).toEqual(["新しいバージョンの公開・配布が必要"]);
    expect(labels({ overview: overview(), failed: false })).not.toContain(
      "新しいバージョンの公開・配布が必要",
    );
  });

  it("同一リポジトリの複数の対象は1件に数える", () => {
    const repo = status("a/one", {
      outdated: true,
      missingRepairWorkflows: ["claude-ci-fix.yml"],
      outdatedSharedFiles: [".github/scripts/signaly-notify.sh"],
    });
    expect(
      labels({ overview: overview({ repositories: [repo, status("a/two", { outdated: true })] }), failed: false }),
    ).toEqual(["配布が必要：2リポジトリ"]);
  });

  it("配布中でもPR未作成の対象を配布が必要と誤らず、実行中でない種別の未着手は併記する", () => {
    const repo = status("a/one", { outdated: true });
    expect(
      labels({
        overview: overview({ repositories: [repo], propagation: running }),
        failed: false,
      }),
    ).toEqual(["配布中"]);

    const both = [repo, status("a/two", { missingRepairWorkflows: ["claude-ci-fix.yml"] })];
    expect(
      labels({ overview: overview({ repositories: both, propagation: running }), failed: false }),
    ).toEqual(["配布が必要：1リポジトリ", "配布中"]);
  });

  it("起動直後でrunがまだ見えない間も配布中", () => {
    const repo = status("a/one", { outdated: true });
    expect(
      labels({ overview: overview({ repositories: [repo] }), failed: false, awaitingRun: true }),
    ).toEqual(["配布中"]);
  });

  it("配布PRが未マージなら反映待ち。最新にはしない", () => {
    const pr = { number: 1, url: "https://example.test/1" };
    const repos = [
      status("a/one", { outdated: true, updatePullRequest: pr }),
      status("a/two", { missingRepairWorkflows: ["claude-ci-fix.yml"], repairPullRequest: pr }),
    ];
    expect(labels({ overview: overview({ repositories: repos }), failed: false })).toEqual([
      "反映待ち：2リポジトリ",
    ]);
  });

  it("未着手と反映待ちが混在しても未着手を隠さない", () => {
    const pr = { number: 1, url: "https://example.test/1" };
    const repos = [
      status("a/one", { outdated: true }),
      status("a/two", { outdated: true, updatePullRequest: pr }),
    ];
    expect(labels({ overview: overview({ repositories: repos }), failed: false })).toEqual([
      "配布が必要：1リポジトリ",
      "反映待ち：1リポジトリ",
    ]);
  });

  it("比較不能・最新タグ不明・一部取得失敗は最新にしない", () => {
    expect(
      labels({ overview: overview({ sourceAhead: { ...sameContent, hasContentDiff: null } }), failed: false }),
    ).toEqual(["確認できません"]);
    expect(labels({ overview: overview({ sourceAhead: null }), failed: false })).toEqual(["確認できません"]);
    expect(labels({ overview: overview({ latest: null }), failed: false })).toEqual(["確認できません"]);
    expect(labels({ overview: overview({ unverifiedRepositories: ["a/x"] }), failed: false })).toEqual([
      "確認できません",
    ]);
  });

  it("必要な対象があり一部未確認なら、必要性を示したうえで併記する", () => {
    expect(
      labels({
        overview: overview({
          repositories: [status("a/one", { outdated: true })],
          unverifiedRepositories: ["a/x"],
        }),
        failed: false,
      }),
    ).toEqual(["配布が必要：1リポジトリ", "一部確認できません"]);
  });

  it("再取得に失敗したら、残っている前回の結果を最新と扱わない", () => {
    expect(labels({ overview: overview(), failed: true })).toEqual(["確認できません"]);
    expect(
      labels({ overview: overview({ repositories: [status("a/one", { outdated: true })] }), failed: true }),
    ).toEqual(["配布が必要：1リポジトリ", "再確認に失敗（前回の結果）"]);
  });
});
