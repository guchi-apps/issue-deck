import { describe, expect, it } from "vitest";

import { RELEASE_VERIFICATION_REPOS } from "@/lib/release-verification-config";
import { getReleaseVerificationConfig } from "@/lib/release-verification-config";
import { evaluateRollout, isRolloutComplete, sortRolloutRows, type RolloutHost } from "@/lib/release-rollout";

const host = (repos: string[], overrides: Partial<RolloutHost> = {}): RolloutHost => ({
  name: "subpc",
  online: true,
  repositories: repos,
  releaseVerifyCapable: true,
  releaseReviewCapable: true,
  ...overrides,
});
const passedBoth = {
  integration: { state: "passed", headSha: "a" },
  ai_review: { state: "passed", headSha: "a" },
};

describe("evaluateRollout", () => {
  it("台帳に無い管理対象は未導入として検出する", () => {
    const row = evaluateRollout({ fullName: "guchi-apps/new-app", hosts: [host(["guchi-apps/new-app"])], latest: passedBoth });
    expect(row.status).toBe("not_registered");
  });

  it("アーカイブ済みの未登録は対象外だが、理由を残す", () => {
    const row = evaluateRollout({ fullName: "guchi-apps/old", archived: true, hosts: [], latest: {} });
    expect(row.status).toBe("excluded");
    expect(row.reasons[0]).toContain("アーカイブ");
  });

  it("根拠付きの対象外は対象外", () => {
    expect(evaluateRollout({ fullName: "guchi-apps/docs", hosts: [], latest: {} }).status).toBe("excluded");
  });

  it("前提不足は設定不足で、実走済みでも検証済みにしない", () => {
    const repo = "guchi-apps/gap-fixture";
    (RELEASE_VERIFICATION_REPOS as Record<string, unknown>)[repo] = {
      enforced: false,
      integrationCommands: ["npm ci"],
      setupGaps: ["テスト用の前提不足"],
    };
    try {
      const row = evaluateRollout({ fullName: repo, hosts: [host([repo])], latest: passedBoth });
      expect(row.status, repo).toBe("setup_missing");
      expect(row.reasons.length).toBeGreaterThan(0);
    } finally {
      delete (RELEASE_VERIFICATION_REPOS as Record<string, unknown>)[repo];
    }
  });

  it("ホストが申告していなければ配布待ち、未対応pollerも配布待ち", () => {
    const repo = "guchi-apps/status-hub";
    expect(evaluateRollout({ fullName: repo, hosts: [], latest: {} }).status).toBe("awaiting_distribution");
    const old = host([repo], { releaseReviewCapable: false });
    const row = evaluateRollout({ fullName: repo, hosts: [old], latest: {} });
    expect(row.status).toBe("awaiting_distribution");
    expect(row.reasons[0]).toContain("未対応");
  });

  it("実走記録が無ければ検証待ち、両方合格なら検証済み（必須化前）", () => {
    const repo = "guchi-apps/status-hub";
    const hosts = [host([repo])];
    const waiting = evaluateRollout({ fullName: repo, hosts, latest: { integration: { state: "failed", headSha: "a" } } });
    expect(waiting.status).toBe("awaiting_verification");
    expect(waiting.reasons.join()).toContain("failed");
    expect(evaluateRollout({ fullName: repo, hosts, latest: passedBoth }).status).toBe("verified");
  });
});

describe("一覧", () => {
  it("対応が要るものを上に並べ、完了は対象外以外が必須化済みのとき", () => {
    const rows = sortRolloutRows([
      evaluateRollout({ fullName: "guchi-apps/docs", hosts: [], latest: {} }),
      evaluateRollout({ fullName: "guchi-apps/new-app", hosts: [], latest: {} }),
    ]);
    expect(rows[0].status).toBe("not_registered");
    expect(isRolloutComplete(rows)).toBe(false);
    expect(isRolloutComplete([rows[1]])).toBe(true);
  });
});

describe("evaluateRollout: 別々の候補の成功", () => {
  it("統合検証と全体レビューが別候補で合格しても検証済みにしない", () => {
    const repo = Object.keys(RELEASE_VERIFICATION_REPOS).find((r) => !getReleaseVerificationConfig(r)?.enforced)!;
    const row = evaluateRollout({
      fullName: repo,
      hosts: [host([repo])],
      latest: {
        integration: { state: "passed", headSha: "a", prNumber: 1, baseSha: "b" },
        ai_review: { state: "passed", headSha: "c", prNumber: 2, baseSha: "b" },
      },
    });
    expect(row.status).not.toBe("verified");
  });
});
