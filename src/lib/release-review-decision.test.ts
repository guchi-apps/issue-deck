import { describe, expect, it } from "vitest";

import {
  assessDecision,
  assessDecisionBase,
  nonFixFindingIds,
  selectAutoFixIndexes,
  summarizeReleaseReviewDecisions,
  validateDecisionInput,
  type DecisionTargetFinding,
  type ReleaseReviewDecisionRecord,
} from "@/lib/release-review-decision";

const BASE = "a".repeat(40);

function record(overrides: Partial<ReleaseReviewDecisionRecord> = {}): ReleaseReviewDecisionRecord {
  return {
    id: "d1",
    findingId: "R-000001",
    sequence: 1,
    decision: "post_release",
    reason: "公開後にしか配布できない",
    impact: null,
    scope: null,
    followUp: { repo: "o/r", number: 4651 },
    timing: "本番公開の直後",
    prNumber: 10,
    headRef: "release-rc/3",
    baseSha: BASE,
    headSha: "b".repeat(40),
    severity: "high",
    blocking: true,
    findingTitle: "共通workflowの修正がフリートへ未配布",
    decidedBy: "user",
    decidedAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

const finding = (id: string, overrides: Partial<DecisionTargetFinding> = {}): DecisionTargetFinding => ({
  id,
  title: `指摘${id}`,
  severity: "high",
  blocking: true,
  ...overrides,
});

const summarize = (records: ReleaseReviewDecisionRecord[], findings: DecisionTargetFinding[], extra: { unverifiedScope?: string | null; baseSha?: string; state?: string } = {}) =>
  summarizeReleaseReviewDecisions({
    records,
    findings,
    suggestions: [],
    current: { baseSha: extra.baseSha ?? BASE },
    state: extra.state ?? "needs_check",
    unverifiedScope: extra.unverifiedScope ?? null,
  });

describe("summarizeReleaseReviewDecisions", () => {
  it("止める指摘の全件が有効な非修正の判断なら解除でき、公開後作業として残す（配布済みとは扱わない）", () => {
    const s = summarize([record()], [finding("R-000001")]);
    expect(s.cleared).toBe(true);
    expect(s.counts).toMatchObject({ undecidedBlocking: 0, postRelease: 1 });
    expect(s.postReleaseWork).toEqual([
      { findingId: "R-000001", title: "指摘R-000001", followUp: { repo: "o/r", number: 4651 }, timing: "本番公開の直後" },
    ]);
    expect(s.next).toContain("判断の保存だけではマージしません");
  });

  it("未判断の止める指摘・「今回直す」が残れば解除しない", () => {
    expect(summarize([record()], [finding("R-000001"), finding("R-000002")]).cleared).toBe(false);
    const fixNow = summarize([record({ decision: "fix_now" })], [finding("R-000001")]);
    expect(fixNow.cleared).toBe(false);
    expect(fixNow.counts.fixNow).toBe(1);
  });

  it("未確認範囲は判断では解除しない（AIの未確認を合格へ書き換えない）", () => {
    const s = summarize([record()], [finding("R-000001")], { unverifiedScope: "差分の一部が未確認" });
    expect(s.cleared).toBe(false);
    expect(s.next).toContain("未確認範囲");
  });

  it("撤回すると未判断へ戻り、履歴は残る", () => {
    const s = summarize(
      [record(), record({ id: "d2", sequence: 2, decision: "withdrawn", reason: "判断し直す" })],
      [finding("R-000001")],
    );
    expect(s.byFinding["R-000001"].current).toBeNull();
    expect(s.byFinding["R-000001"].history).toHaveLength(2);
    expect(s.counts.undecidedBlocking).toBe(1);
    expect(s.cleared).toBe(false);
  });

  it("最新の判断（通し番号の大きいもの）を使う", () => {
    const s = summarize([record({ id: "d2", sequence: 2, decision: "reject", reason: "誤認" }), record()], [finding("R-000001")]);
    expect(s.byFinding["R-000001"].current?.decision).toBe("reject");
    expect(s.counts.rejected).toBe(1);
  });

  it("前提が変わった判断は無効で、再確認を求める", () => {
    const moved = summarize([record()], [finding("R-000001")], { baseSha: "c".repeat(40) });
    expect(moved.cleared).toBe(false);
    expect(moved.counts).toMatchObject({ stale: 1, undecidedBlocking: 1 });
    expect(moved.byFinding["R-000001"].stale).toContain("mainが進みました");
    const premise = summarize([record()], [finding("R-000001", { premiseChanged: "配布方法が変わった" })]);
    expect(premise.byFinding["R-000001"].stale).toContain("配布方法が変わった");
  });

  it("今回の結果に無い指摘の判断は、外れた可能性として出す（黙って消さない）", () => {
    const s = summarize([record({ findingId: "R-0000ff" })], [finding("R-000001")]);
    expect(s.detached.map((d) => d.findingId)).toEqual(["R-0000ff"]);
    expect(s.cleared).toBe(false);
  });

  it("全体レビューが要確認でなければ解除しない（失敗・実行中は対象外）", () => {
    expect(summarize([record()], [finding("R-000001")], { state: "failed" }).cleared).toBe(false);
  });
});

describe("assessDecision", () => {
  it("重大度が上がった・止めない提案から止める指摘になったときは再確認", () => {
    expect(assessDecision(record({ severity: "medium" }), finding("R-000001"), { baseSha: BASE })).toContain("重大度が上がりました");
    expect(assessDecision(record({ severity: "high", blocking: false }), finding("R-000001"), { baseSha: BASE })).toContain("止める指摘");
    // 文言の違いだけ（重大度・前提が同じ）なら有効なまま
    expect(assessDecision(record(), finding("R-000001", { title: "言い換えた題" }), { baseSha: BASE })).toBeNull();
  });
});

describe("判断の無効化はファイル単位（#4766）", () => {
  const NEW_BASE = "c".repeat(40);
  const target = finding("R-000001", { file: "src/a.ts" });

  it("mainが無関係に進んでも、対象ファイルが変わっていなければ判断は残る", () => {
    const current = { baseSha: NEW_BASE, baseChanges: { [BASE]: ["src/other.ts", "docs/x.md"] } };
    expect(assessDecision(record(), target, current)).toBeNull();
    const s = summarizeReleaseReviewDecisions({ records: [record()], findings: [target], suggestions: [], current, state: "needs_check", unverifiedScope: null });
    expect(s.counts.stale).toBe(0);
    expect(s.counts.undecidedBlocking).toBe(0);
    expect(s.cleared).toBe(true);
  });

  it("対象ファイルが変われば無効になる（改名前のパスでも）", () => {
    expect(assessDecision(record(), target, { baseSha: NEW_BASE, baseChanges: { [BASE]: ["src/a.ts"] } })).toContain("src/a.ts");
    const s = summarizeReleaseReviewDecisions({
      records: [record()],
      findings: [target],
      suggestions: [],
      current: { baseSha: NEW_BASE, baseChanges: { [BASE]: ["src/a.ts"] } },
      state: "needs_check",
      unverifiedScope: null,
    });
    expect(s.counts.stale).toBe(1);
    expect(s.counts.undecidedBlocking).toBe(1);
  });

  it("変更を確かめられない・ファイルが分からないときは従来どおり無効", () => {
    expect(assessDecisionBase(BASE, "src/a.ts", { baseSha: NEW_BASE })).toContain("確かめられない");
    expect(assessDecisionBase(BASE, "src/a.ts", { baseSha: NEW_BASE, baseChanges: { [BASE]: null } })).toContain("確かめられない");
    expect(assessDecisionBase(BASE, null, { baseSha: NEW_BASE, baseChanges: { [BASE]: [] } })).toContain("ファイルが分からない");
    expect(assessDecisionBase(BASE, null, { baseSha: BASE })).toBeNull();
  });

  it("重大度の上昇・前提変化の報告による無効化は残る", () => {
    const current = { baseSha: NEW_BASE, baseChanges: { [BASE]: [] } };
    expect(assessDecision(record({ severity: "low" }), target, current)).toContain("重大度が上がりました");
    expect(assessDecision(record({ blocking: false }), target, current)).toContain("止める指摘");
    expect(assessDecision(record(), { ...target, premiseChanged: "対象が広がった" }, current)).toContain("前提の変化");
  });
});

describe("旧IDの判断の引き継ぎ（#4766）", () => {
  it("旧IDで保存した判断を、別名に旧IDを持つ今の指摘の判断として読む", () => {
    const s = summarize([record({ findingId: "R-legacy" })], [finding("R-new", { aliasIds: ["R-legacy"] })]);
    expect(s.byFinding["R-new"].current?.findingId).toBe("R-legacy");
    expect(s.byFinding["R-new"].aliasIds).toEqual(["R-legacy"]);
    expect(s.detached).toEqual([]);
    expect(s.cleared).toBe(true);
    expect([...nonFixFindingIds(s)].sort()).toEqual(["R-legacy", "R-new"]);
  });

  it("複数の指摘に当たる別名では読み替えない（別の指摘の判断で覆わない）", () => {
    const s = summarize(
      [record({ findingId: "R-new" })],
      [finding("R-legacyA", { aliasIds: ["R-new"] }), finding("R-legacyB", { aliasIds: ["R-new"] })],
    );
    expect(s.byFinding["R-legacyA"]).toBeUndefined();
    expect(s.byFinding["R-legacyB"]).toBeUndefined();
    expect(s.counts.undecidedBlocking).toBe(2);
    expect(s.cleared).toBe(false);
  });

  it("旧IDと新IDの判断が両方あるときは、判断時刻の新しいほうが今の判断", () => {
    const s = summarize(
      [
        record({ id: "old", findingId: "R-legacy", sequence: 2, decidedAt: "2026-10-15T00:00:00.000Z" }),
        record({ id: "new", findingId: "R-new", sequence: 1, decision: "fix_now", followUp: null, decidedAt: "2026-10-16T00:00:00.000Z" }),
      ],
      [finding("R-new", { aliasIds: ["R-legacy"] })],
    );
    expect(s.byFinding["R-new"].current?.id).toBe("new");
    expect(s.byFinding["R-new"].history.map((r) => r.id)).toEqual(["old", "new"]);
  });
});

describe("selectAutoFixIndexes", () => {
  it("見送り・不採用・公開後対応は自動修正から外し、今回直す・未判断・前提が変わったものは直す", () => {
    const findings = [finding("R-000001"), finding("R-000002"), finding("R-000003"), finding("R-000004")];
    const s = summarize(
      [
        record({ findingId: "R-000001", decision: "defer", impact: "影響", scope: "範囲" }),
        record({ findingId: "R-000002", decision: "fix_now" }),
        record({ findingId: "R-000004", decision: "reject", baseSha: "c".repeat(40) }),
      ],
      findings,
    );
    expect(selectAutoFixIndexes(findings, s)).toEqual([1, 2, 3]);
    expect([...nonFixFindingIds(s)]).toEqual(["R-000001"]);
    expect(selectAutoFixIndexes(findings, null)).toEqual([0, 1, 2, 3]);
  });
});

describe("validateDecisionInput", () => {
  const base = { reason: "理由", impact: null, scope: null, timing: null, followUp: null };
  it("理由はすべての判断で必須", () => {
    expect(validateDecisionInput({ ...base, decision: "reject", reason: " " })?.field).toBe("reason");
  });
  it("見送りは残る影響と対象範囲が必須で、Issueは付けない", () => {
    expect(validateDecisionInput({ ...base, decision: "defer" })?.field).toBe("impact");
    expect(validateDecisionInput({ ...base, decision: "defer", impact: "影響" })?.field).toBe("scope");
    expect(validateDecisionInput({ ...base, decision: "defer", impact: "影響", scope: "範囲" })).toBeNull();
    expect(
      validateDecisionInput({ ...base, decision: "defer", impact: "影響", scope: "範囲", followUp: { kind: "create", title: "t" } })?.field,
    ).toBe("followUp");
  });
  it("公開後対応は関連Issueと実施時期が必須", () => {
    expect(validateDecisionInput({ ...base, decision: "post_release" })?.field).toBe("followUp");
    expect(validateDecisionInput({ ...base, decision: "post_release", followUp: { kind: "existing", number: 4651 } })?.field).toBe("timing");
    expect(
      validateDecisionInput({ ...base, decision: "post_release", followUp: { kind: "existing", number: 4651 }, timing: "公開直後" }),
    ).toBeNull();
  });
});
