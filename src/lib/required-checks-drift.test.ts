import { describe, expect, it } from "vitest";

import {
  buildPublisherSet,
  detectRequiredCheckDrift,
  extractSignature,
  buildDriftIssueBody,
  workflowJobNames,
} from "@/lib/required-checks-drift";

const yaml = `name: CI
on: push
jobs:
  lint-and-build:
    runs-on: ubuntu-latest
  other:
    name: "Other Check"
    runs-on: x
  dyn:
    name: \${{ matrix.x }}
`;

describe("workflowJobNames", () => {
  it("ジョブIDと静的なnameを拾い、式を含む名前は拾わない", () => {
    expect(workflowJobNames(yaml)).toEqual(["lint-and-build", "other", "Other Check", "dyn"]);
  });
});

describe("detectRequiredCheckDrift", () => {
  const publishers = buildPublisherSet({ manifestGroups: ["docs-sync-check"], workflowYamls: [yaml] });

  it("両方にあり発行元もあれば何も出ない", () => {
    expect(detectRequiredCheckDrift({ ruleset: ["lint-and-build"], classic: ["lint-and-build"] }, publishers)).toEqual([]);
  });
  it("classicにだけ残った廃止済みチェックは発行元なしとして出る（#5298）", () => {
    expect(
      detectRequiredCheckDrift({ ruleset: ["lint-and-build"], classic: ["lint-and-build", "issue-deck/ci-gate"] }, publishers),
    ).toEqual([{ kind: "no_publisher", name: "issue-deck/ci-gate", where: ["classic"] }]);
  });
  it("発行元はあるが片側にしか無い項目はずれとして出る", () => {
    expect(detectRequiredCheckDrift({ ruleset: ["docs-sync-check"], classic: [] }, publishers)).toEqual([
      { kind: "only_in_ruleset", name: "docs-sync-check" },
    ]);
    expect(detectRequiredCheckDrift({ ruleset: [], classic: ["other"] }, publishers)).toEqual([
      { kind: "only_in_classic", name: "other" },
    ]);
  });
  it("コードが発行するcommit statusは発行元ありとして扱う", () => {
    expect(detectRequiredCheckDrift({ ruleset: ["issue-deck/ios-precheck"], classic: ["issue-deck/ios-precheck"] }, publishers)).toEqual([]);
  });
});

describe("Issue本文", () => {
  it("署名を埋め込み、取り出せる", () => {
    const body = buildDriftIssueBody({ repositoryFullName: "a/b", byBranch: [], signature: "develop:x" });
    expect(extractSignature(body)).toBe("develop:x");
  });
});
