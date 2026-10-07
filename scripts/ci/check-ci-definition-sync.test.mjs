import { describe, expect, it } from "vitest";

import { checkSync, extractJobs } from "./check-ci-definition-sync.mjs";
import { expandChecks } from "./run-required-checks.mjs";

const manifest = {
  schemaVersion: 1,
  groups: { "lint-and-build": { checks: [{ id: "lint", run: "pnpm lint" }] } },
};
const ciYaml = `name: CI
jobs:
  lint-and-build:
    steps:
      - run: node scripts/ci/run-required-checks.mjs --group lint-and-build
  notify:
    steps:
      - run: echo hi
`;
const circleYaml = "node /tmp/trusted/run-required-checks.mjs --all \\\n";

describe("check-ci-definition-sync", () => {
  it("ジョブを取り出す", () => {
    expect([...extractJobs(ciYaml).keys()]).toEqual(["lint-and-build", "notify"]);
  });

  it("一致していればエラーなし", () => {
    expect(checkSync({ manifest, ciYaml, circleYaml, exists: () => true })).toEqual([]);
  });

  it("定義の外に検査ジョブを足すと落ちる", () => {
    const yaml = `${ciYaml}  extra-check:\n    steps:\n      - run: pnpm x\n`;
    expect(checkSync({ manifest, ciYaml: yaml, circleYaml, exists: () => true }).join()).toContain("extra-check");
  });

  it("ジョブがランナーを呼ばない・CircleCIが全グループを走らせないと落ちる", () => {
    const yaml = ciYaml.replace("--group lint-and-build", "--group other");
    expect(checkSync({ manifest, ciYaml: yaml, circleYaml, exists: () => true }).length).toBe(1);
    expect(checkSync({ manifest, ciYaml, circleYaml: "node x.mjs", exists: () => true }).length).toBe(1);
    expect(checkSync({ manifest, ciYaml, circleYaml: null, exists: () => true }).length).toBe(1);
  });

  it("参照先のスクリプトが無いと落ちる", () => {
    const m = { schemaVersion: 1, groups: { "lint-and-build": { checks: [{ id: "x", run: "scripts/missing.sh" }] } } };
    expect(checkSync({ manifest: m, ciYaml, circleYaml, exists: () => false }).join()).toContain("scripts/missing.sh");
  });
});

describe("run-required-checks expandChecks", () => {
  it("存在しないグループ・空のグループは例外（0件で通さない）", () => {
    expect(() => expandChecks(manifest, ["nope"])).toThrow();
    expect(() => expandChecks({ schemaVersion: 1, groups: { a: { checks: [] } } }, null)).toThrow();
    expect(expandChecks(manifest, null)).toHaveLength(1);
  });
});
