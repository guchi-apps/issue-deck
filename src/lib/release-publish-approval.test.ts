import { describe, expect, it } from "vitest";

import {
  decidePublishApprovalValidity,
  describePublishProgress,
  isWithinApprovalTarget,
  type PublishApprovalFinalization,
} from "@/lib/release-publish-approval";

const BASE = "b".repeat(40);
const PRE = "a".repeat(40);
const POST = "c".repeat(40);
const now = new Date("2026-10-16T00:00:00Z");
const approval = { status: "active" as const, baseSha: BASE, headSha: PRE, expiresAt: new Date(now.getTime() + 60_000) };

function bump(over: Partial<PublishApprovalFinalization> = {}): PublishApprovalFinalization {
  return {
    status: "applied",
    preBaseSha: BASE,
    preHeadSha: PRE,
    finalBaseSha: BASE,
    finalHeadSha: POST,
    files: [
      { path: "package.json", category: "version" },
      { path: "src/data/changelog.ts", category: "changelog" },
    ],
    ...over,
  };
}

describe("decidePublishApprovalValidity", () => {
  it("承認した候補のまま・想定したバンプ（版・更新履歴のみ）の後は失効させない", () => {
    expect(decidePublishApprovalValidity({ approval, now, candidatePhase: "preparing", finalizations: [], observed: { headSha: PRE, mainSha: BASE } })).toEqual({
      valid: true,
      finalHeadSha: null,
    });
    expect(
      decidePublishApprovalValidity({ approval, now, candidatePhase: "awaiting_approval", finalizations: [bump()], observed: { headSha: POST, mainSha: BASE } }),
    ).toEqual({ valid: true, finalHeadSha: POST });
  });

  it("バンプで版・更新履歴以外が変わったら、差分を示して失効させる", () => {
    const result = decidePublishApprovalValidity({
      approval,
      now,
      candidatePhase: "awaiting_approval",
      finalizations: [bump({ files: [{ path: "package.json", category: "version" }, { path: "src/app.ts", category: "other" }] })],
      observed: { headSha: POST, mainSha: BASE },
    });
    expect(result).toMatchObject({ valid: false, reason: "unexpected_changes", diff: ["src/app.ts"] });
  });

  it("iOSの設定が版番号の行だけの書き換えなら失効させない（#4744と同じ差分）", () => {
    const result = decidePublishApprovalValidity({
      approval,
      now,
      candidatePhase: "awaiting_approval",
      finalizations: [bump({ files: [{ path: "package.json", category: "version" }, { path: "ios/IssueDeck.xcodeproj/project.pbxproj", category: "ios_version", versionLinesOnly: true }] })],
      observed: { headSha: POST, mainSha: BASE },
    });
    expect(result).toMatchObject({ valid: true });
  });

  it("iOSの設定で版番号以外の行も変わった（または判定できない）なら失効", () => {
    const result = decidePublishApprovalValidity({
      approval,
      now,
      candidatePhase: "awaiting_approval",
      finalizations: [bump({ files: [{ path: "ios/IssueDeck.xcodeproj/project.pbxproj", category: "ios_version" }] })],
      observed: { headSha: POST, mainSha: BASE },
    });
    expect(result).toMatchObject({ valid: false, reason: "unexpected_changes", diff: ["ios/IssueDeck.xcodeproj/project.pbxproj"] });
  });

  it("承認した後の候補の更新・置換（範囲外のhead）は失効", () => {
    const result = decidePublishApprovalValidity({ approval, now, candidatePhase: "review", finalizations: [bump()], observed: { headSha: "d".repeat(40), mainSha: BASE } });
    expect(result).toMatchObject({ valid: false, reason: "candidate_changed" });
  });

  it("mainが進んだら失効（バンプ時のbaseが違う場合も）", () => {
    expect(decidePublishApprovalValidity({ approval, now, candidatePhase: "preparing", finalizations: [], observed: { headSha: PRE, mainSha: "e".repeat(40) } })).toMatchObject({
      valid: false,
      reason: "main_advanced",
    });
    expect(
      decidePublishApprovalValidity({ approval, now, candidatePhase: "preparing", finalizations: [bump({ finalBaseSha: "e".repeat(40) })], observed: null }),
    ).toMatchObject({ valid: false, reason: "main_advanced" });
  });

  it("期限切れ・候補の取消は観測できなくても失効", () => {
    expect(decidePublishApprovalValidity({ approval: { ...approval, expiresAt: now }, now, candidatePhase: "preparing", finalizations: [], observed: null })).toMatchObject({
      reason: "expired",
    });
    expect(decidePublishApprovalValidity({ approval, now, candidatePhase: "cancelled", finalizations: [], observed: null })).toMatchObject({ reason: "candidate_cancelled" });
  });

  it("観測できないときは成功にも失効にもしない", () => {
    expect(decidePublishApprovalValidity({ approval, now, candidatePhase: "preparing", finalizations: [], observed: null })).toBeNull();
  });

  it("要求中・期限切れの公開準備はバンプ後の対応として扱わない", () => {
    const result = decidePublishApprovalValidity({
      approval,
      now,
      candidatePhase: "preparing",
      finalizations: [bump({ status: "requested" })],
      observed: { headSha: POST, mainSha: BASE },
    });
    expect(result).toMatchObject({ valid: false, reason: "candidate_changed" });
  });
});

describe("isWithinApprovalTarget", () => {
  it("同じ対象・範囲内のバンプ後headからの再試行は同じ承認を使い回す", () => {
    expect(isWithinApprovalTarget({ approval, finalizations: [], target: { baseSha: BASE, headSha: PRE } })).toBe(true);
    // バンプ後に最終検証が失敗して修正工程へ戻った候補（headはバンプ後のまま）
    expect(isWithinApprovalTarget({ approval, finalizations: [bump({ status: "failed" })], target: { baseSha: BASE, headSha: POST } })).toBe(true);
  });

  it("コード変更後・mainの前進後の再試行は新しい承認が要る", () => {
    expect(isWithinApprovalTarget({ approval, finalizations: [bump()], target: { baseSha: BASE, headSha: "d".repeat(40) } })).toBe(false);
    expect(isWithinApprovalTarget({ approval, finalizations: [], target: { baseSha: "e".repeat(40), headSha: PRE } })).toBe(false);
    expect(
      isWithinApprovalTarget({ approval, finalizations: [bump({ files: [{ path: "src/x.ts", category: "other" }] })], target: { baseSha: BASE, headSha: POST } }),
    ).toBe(false);
  });
});

describe("describePublishProgress", () => {
  const run = (status: string, active = true) => ({ status, active });
  it("承認済みの候補は「本番承認待ち」ではなく実処理の段階を出す", () => {
    expect(describePublishProgress({ phase: "preparing", approval: { status: "active" }, run: run("checking") })).toBe("final_checks");
    expect(describePublishProgress({ phase: "awaiting_approval", approval: { status: "active" }, run: run("checking") })).toBe("auto_publish");
    expect(describePublishProgress({ phase: "awaiting_approval", approval: { status: "merging" }, run: run("merging") })).toBe("deploying");
    expect(describePublishProgress({ phase: "deploying", approval: { status: "consumed" }, run: run("releasing") })).toBe("deploying");
    expect(describePublishProgress({ phase: "verifying_production", approval: { status: "consumed" }, run: run("verifying") })).toBe("verifying_production");
    expect(describePublishProgress({ phase: "completed", approval: { status: "consumed" }, run: run("completed", false) })).toBe("completed");
  });

  it("止まった・失効・取消・承認なしを区別する", () => {
    expect(describePublishProgress({ phase: "awaiting_approval", approval: { status: "active" }, run: run("needs_attention", false) })).toBe("stopped");
    expect(describePublishProgress({ phase: "awaiting_approval", approval: { status: "active" }, run: null })).toBe("stopped");
    expect(describePublishProgress({ phase: "awaiting_approval", approval: { status: "invalidated" }, run: null })).toBe("invalidated");
    expect(describePublishProgress({ phase: "awaiting_approval", approval: { status: "revoked" }, run: null })).toBe("revoked");
    expect(describePublishProgress({ phase: "awaiting_approval", approval: null, run: null })).toBe("needs_approval");
  });
});
