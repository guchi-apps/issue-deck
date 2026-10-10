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

  it("DBが要るビルドの前提が無いものは設定不足", () => {
    expect(describeIntegrationSetupGap("guchi-apps/db-console")).toContain("前提が未整備");
  });

  it("Mac検証のスクリプト未配布はMac前提不足として出るが、Linux統合検証は止めない", () => {
    expect(describeMacSetupGap("guchi-apps/aide")).toContain("remote-build-check.sh");
    expect(describeIntegrationSetupGap("guchi-apps/aide")).toBeNull();
    expect(describeMacSetupGap("guchi-apps/issue-deck")).toBeNull();
  });
});
