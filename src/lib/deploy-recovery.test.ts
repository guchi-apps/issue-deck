import { describe, expect, it } from "vitest";

import {
  deployRecoveryErrorMessage,
  normalizeDeployRecoverySelection,
  resolveDeployRecoverySelection,
  selectDeployRecoveryCandidates,
} from "@/lib/deploy-recovery";

const candidates = [
  { number: 4, title: "先", url: "https://example.test/4", mergedAt: "2026-10-01T00:00:00Z", mergeCommitSha: "four" },
  { number: 8, title: "後", url: "https://example.test/8", mergedAt: "2026-10-02T00:00:00Z", mergeCommitSha: "eight" },
];

describe("deploy recovery（#3913）", () => {
  it("main未反映のマージ済みPRだけを取り込み順にする", () => {
    expect(selectDeployRecoveryCandidates([...candidates].reverse(), new Set(["four"]))).toEqual([candidates[0]]);
  });

  it("選択を重複なく正規化する", () => {
    expect(normalizeDeployRecoverySelection([8, 4, 8])).toEqual([8, 4]);
    expect(normalizeDeployRecoverySelection([])).toBeNull();
    expect(normalizeDeployRecoverySelection(["4"])).toBeNull();
  });

  it("現在の候補で選択を検証し、取り込み順に揃える", () => {
    expect(resolveDeployRecoverySelection(candidates, [8, 4])).toEqual(candidates);
    expect(resolveDeployRecoverySelection(candidates, [4, 9])).toBeNull();
  });

  it("競合時は選択を見直す文言を返す", () => {
    expect(deployRecoveryErrorMessage(409, "recovery_conflict", undefined)).toContain("競合");
  });
});
