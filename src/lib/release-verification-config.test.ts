import { describe, expect, it } from "vitest";

import {
  describeIntegrationNotApplicable,
  describeIntegrationSetupGap,
  describeMacSetupGap,
  isRegisteredForReleaseVerification,
  RELEASE_VERIFICATION_EXCLUSIONS,
  RELEASE_VERIFICATION_REPOS,
} from "@/lib/release-verification-config";

describe("導入台帳の宣言", () => {
  it("検証対象と対象外が重複しない", () => {
    for (const repo of Object.keys(RELEASE_VERIFICATION_REPOS)) {
      expect(RELEASE_VERIFICATION_EXCLUSIONS[repo], repo).toBeUndefined();
    }
  });

  it("検証対象はすべて統合検証のコマンドを持つ（pnpm前提の流用でなく個別に宣言）", () => {
    for (const [repo, config] of Object.entries(RELEASE_VERIFICATION_REPOS)) {
      expect(config.integrationCommands?.length, repo).toBeGreaterThan(0);
    }
  });

  it("設定不足・Mac前提不足のあるリポジトリはenforcedにできない", () => {
    for (const [repo, config] of Object.entries(RELEASE_VERIFICATION_REPOS)) {
      if (!config.enforced) continue;
      expect(describeIntegrationSetupGap(repo), repo).toBeNull();
      expect(describeMacSetupGap(repo), repo).toBeNull();
    }
  });
});

describe("対象外と設定不足の区別", () => {
  it("アーカイブ済みは根拠付きの対象外で、設定不足ではない", () => {
    expect(describeIntegrationNotApplicable("guchi-apps/trainroute")).toContain("アーカイブ");
    expect(describeIntegrationSetupGap("guchi-apps/trainroute")).toBeNull();
  });

  it("台帳に無いリポジトリは対象外にならず、未導入の設定不足になる", () => {
    expect(isRegisteredForReleaseVerification("guchi-apps/new-app")).toBe(false);
    expect(describeIntegrationNotApplicable("guchi-apps/new-app")).toBeNull();
    expect(describeIntegrationSetupGap("guchi-apps/new-app")).toContain("未導入");
  });

  it("検証用DBを準備済みのasset-managerは、静的な前提不足として止めない", () => {
    expect(describeIntegrationSetupGap("guchi-apps/asset-manager")).toBeNull();
    expect(RELEASE_VERIFICATION_REPOS["guchi-apps/asset-manager"].integrationCommands).toContain("npm run verify:build");
  });

  it("Mac検証のスクリプトが配布済みなら、Mac前提不足もLinux統合検証の止まりも無い", () => {
    for (const repo of ["aide", "kurashio", "yoteiflow", "morrow", "issue-deck"]) {
      expect(describeMacSetupGap(`guchi-apps/${repo}`), repo).toBeNull();
      expect(describeIntegrationSetupGap(`guchi-apps/${repo}`), repo).toBeNull();
    }
    expect(describeIntegrationSetupGap("guchi-apps/db-console")).toBeNull();
  });
});


describe("公開Piリポジトリのリリース検証", () => {
  it("新側はPythonのオフライン検証対象で、旧側の対象外を引き継がない", () => {
    const repo = "guchi-apps/pi0w";
    expect(isRegisteredForReleaseVerification(repo)).toBe(true);
    expect(describeIntegrationNotApplicable(repo)).toBeNull();
    expect(describeIntegrationSetupGap(repo)).toBeNull();
    const config = RELEASE_VERIFICATION_REPOS[repo];
    expect(config.enforced).toBe(false);
    expect(config.macBuildCheck).not.toBe(true);
    expect(config.integrationCommands).toEqual([
      "python3 -m venv .venv && . .venv/bin/activate && python -m pip install -r requirements-ci.txt && bash scripts/verify.sh",
    ]);
  });
});
