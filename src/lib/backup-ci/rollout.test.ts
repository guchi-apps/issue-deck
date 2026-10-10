import { describe, expect, it } from "vitest";

import { digestDefinition } from "@/lib/backup-ci/crypto";
import {
  assessRollout,
  buildMigrationCommands,
  classifyCiJob,
  compareCiJobsToDefinition,
  definitionGroupNames,
  extractCiWorkflowJobs,
  type RolloutInput,
} from "@/lib/backup-ci/rollout";

const CI = `name: CI
on:
  pull_request:
jobs:
  lint-and-build:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm lint
  ios-build:
    name: iOS build
    runs-on: macos-14
  notify:
    needs: [lint-and-build]
    runs-on: ubuntu-latest
`;

describe("extractCiWorkflowJobs", () => {
  it("ジョブID・name・runs-onを読む", () => {
    expect(extractCiWorkflowJobs(CI)).toEqual([
      { id: "lint-and-build", name: "lint-and-build", runsOn: "ubuntu-latest" },
      { id: "ios-build", name: "iOS build", runsOn: "macos-14" },
      { id: "notify", name: "notify", runsOn: "ubuntu-latest" },
    ]);
  });
  it("jobsが無ければnull（成功扱いにしない）", () => {
    expect(extractCiWorkflowJobs("name: CI\n")).toBeNull();
  });
});

describe("classifyCiJob / compareCiJobsToDefinition", () => {
  const jobs = extractCiWorkflowJobs(CI)!;
  it("通知・Mac系を必須から外す", () => {
    expect(jobs.map(classifyCiJob)).toEqual(["required", "unsupported", "notification"]);
  });
  it("定義と一致すればok。Mac系は代替不可として残る", () => {
    const r = compareCiJobsToDefinition(jobs, ["lint-and-build"]);
    expect(r.ok).toBe(true);
    expect(r.unsupportedJobs).toEqual(["iOS build"]);
  });
  it("グループにジョブが無い・必須ジョブがグループに無いは欠落", () => {
    const r = compareCiJobsToDefinition(jobs, ["build"]);
    expect(r.ok).toBe(false);
    expect(r.groupsWithoutJob).toEqual(["build"]);
    expect(r.jobsWithoutGroup).toEqual(["lint-and-build"]);
  });
});

describe("excludedJobs", () => {
  it("定義で意図して除外したジョブは欠落扱いにしない", () => {
    const jobs = [{ id: "backend", name: "backend", runsOn: "ubuntu-latest" }, { id: "frontend", name: "frontend", runsOn: "ubuntu-latest" }];
    expect(compareCiJobsToDefinition(jobs, ["frontend"]).ok).toBe(false);
    const r = compareCiJobsToDefinition(jobs, ["frontend"], ["backend"]);
    expect(r.ok).toBe(true);
    expect(r.unsupportedJobs).toEqual(["backend"]);
  });
});

describe("definitionGroupNames", () => {
  it("壊れた定義はnull", () => {
    expect(definitionGroupNames("{")).toBeNull();
    expect(definitionGroupNames('{"schemaVersion":2,"groups":{}}')).toBeNull();
    expect(definitionGroupNames('{"schemaVersion":1,"groups":{"a":{}}}')).toEqual(["a"]);
  });
});

const definitionRaw = '{"schemaVersion":1,"groups":{"lint-and-build":{"checks":[]}}}';
const ok = (over: Partial<RolloutInput> = {}): RolloutInput => ({
  files: { ".circleci/config.yml": { matchesSource: true }, "scripts/ci/run-required-checks.mjs": { matchesSource: true } },
  ciJobs: extractCiWorkflowJobs(CI),
  definitionRaw,
  definitionMatchesGenerated: true,
  packageManager: "pnpm",
  setting: { enabled: true, circleciProjectSlug: "circleci/a/b", circleciDefinitionId: "0123abcd-ef", mirrorActionsToCiGate: true },
  tokenConfigured: true,
  hasPassedRun: true,
  hasPublishedGate: true,
  ...over,
});

describe("assessRollout", () => {
  it("全部揃えば利用可能", () => {
    expect(assessRollout(ok()).status).toBe("ready");
  });
  it("配布物が無ければ未導入", () => {
    expect(assessRollout(ok({ files: {}, definitionRaw: null })).status).toBe("not_installed");
  });
  it("ci.ymlと定義がずれていれば設定不足", () => {
    const r = assessRollout(ok({ definitionRaw: '{"schemaVersion":1,"groups":{"x":{}}}' }));
    expect(r.status).toBe("needs_setup");
    expect(r.missing.join()).toContain("x");
  });
  it("配布元と違えば更新必要（ランナー）", () => {
    const r = assessRollout(ok({ files: { ".circleci/config.yml": { matchesSource: true }, "scripts/ci/run-required-checks.mjs": { matchesSource: false } } }));
    expect(r.status).toBe("update_required");
  });
  it("CircleCI設定が無ければ設定不足、合格実績が無ければ検証待ち", () => {
    expect(assessRollout(ok({ setting: null })).status).toBe("needs_setup");
    expect(assessRollout(ok({ hasPassedRun: false })).status).toBe("awaiting_verification");
    expect(assessRollout(ok({ hasPublishedGate: false })).status).toBe("awaiting_verification");
  });
  it("pnpm以外は対象外", () => {
    expect(assessRollout(ok({ packageManager: "other" })).status).toBe("unsupported");
  });
});

describe("buildMigrationCommands", () => {
  it("置き換えるジョブ名だけを入れ替え、復元は保存したrulesetを戻す", () => {
    const c = buildMigrationCommands("guchi-apps/status-hub", ["verify"]);
    expect(c.migrate).toContain("--argjson names '[\"verify\"]'");
    expect(c.migrate).toContain("repos/guchi-apps/status-hub/rulesets");
    expect(c.backup).toContain("ruleset-backup-guchi-apps-status-hub.json");
    expect(c.restore).toContain("ruleset-backup-guchi-apps-status-hub.json");
  });
});

describe("ランナーとサーバーのダイジェスト計算", () => {
  it("run-required-checks.mjsのdigestDefinitionとcrypto.tsが同じ値を返す", async () => {
    const { digestDefinition: runner } = await import("../../../scripts/ci/run-required-checks.mjs");
    const raw = Buffer.from(definitionRaw);
    expect(runner(raw)).toBe(digestDefinition(raw));
  });
});
