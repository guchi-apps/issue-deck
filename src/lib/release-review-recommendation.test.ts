import { describe, expect, it } from "vitest";

import {
  buildRecommendationPrompt,
  classifyReasonSource,
  describeAdoption,
  draftToDecisionInput,
  oneTapBlocker,
  parseRecommendationResponse,
  type ReleaseReviewRecommendation,
} from "@/lib/release-review-recommendation";

const drafts = {
  fix_now: { reason: "公開前に直す" },
  post_release: { reason: "公開後に追跡する", timing: "本番公開の直後", followUpTitle: "移行手順を追記する" },
  defer: { reason: "今回は見送る", impact: "旧形式が残ると表示されない", scope: "v7以前のデータ" },
  reject: { reason: "対象外" },
};

const response = (items: unknown[]) => JSON.stringify({ recommendations: items });

function parse(item: Record<string, unknown>, ids = ["R-000001"]) {
  return parseRecommendationResponse(response([{ id: "R-000001", recommended: "fix_now", rationale: "通常操作でデータが消える", missing: [], drafts, ...item }]), ids);
}

function rec(over: Partial<ReleaseReviewRecommendation> = {}): ReleaseReviewRecommendation {
  const parsed = parse({}).get("R-000001");
  if (!parsed) throw new Error("parse failed");
  return { id: "rec1", findingId: "R-000001", baseSha: "b", headSha: "h", createdAt: "", ...parsed, ...over };
}

describe("parseRecommendationResponse", () => {
  it("推奨・根拠・4種類の理由案を読む", () => {
    const r = parse({}).get("R-000001");
    expect(r?.recommended).toBe("fix_now");
    expect(r?.drafts.defer).toEqual({ reason: "今回は見送る", impact: "旧形式が残ると表示されない", scope: "v7以前のデータ", timing: null, followUpTitle: null });
    expect(r?.drafts.post_release.followUpTitle).toBe("移行手順を追記する");
    expect(r?.missing).toEqual([]);
  });

  it("前後に文章があってもJSONを取り出し、頼んでいない指摘・重複は捨てる", () => {
    const text = `結果です\n${response([
      { id: "R-999999", recommended: "reject", rationale: "x", drafts },
      { id: "R-000001", recommended: "reject", rationale: "1件目", drafts },
      { id: "R-000001", recommended: "fix_now", rationale: "2件目", drafts },
    ])}\n以上`;
    const map = parseRecommendationResponse(text, ["R-000001"]);
    expect([...map.keys()]).toEqual(["R-000001"]);
    expect(map.get("R-000001")?.rationale).toBe("1件目");
  });

  it("判断の種類が不正・根拠が無い・推奨した判断の理由案が無いものは推奨にしない（失敗として扱う）", () => {
    expect(parse({ recommended: "merge" }).size).toBe(0);
    expect(parse({ rationale: "" }).size).toBe(0);
    expect(parse({ drafts: { ...drafts, fix_now: { reason: "" } } }).size).toBe(0);
    expect(parseRecommendationResponse("not json", ["R-000001"]).size).toBe(0);
  });

  it("「該当しません」のような中身の無い理由案は空として扱う", () => {
    const r = parse({ drafts: { ...drafts, reject: { reason: "該当しません。" }, defer: { reason: "なし", impact: "x", scope: "y" } } }).get("R-000001");
    expect(r?.drafts.reject.reason).toBe("");
    expect(r?.drafts.defer.reason).toBe("");
    const p = parse({ drafts: { ...drafts, post_release: { reason: "後で", timing: "該当しません", followUpTitle: "該当なし" } } }).get("R-000001");
    expect(p?.drafts.post_release).toMatchObject({ timing: null, followUpTitle: null });
    expect(parse({ recommended: "reject", drafts: { ...drafts, reject: { reason: "該当なし" } } }).size).toBe(0);
  });

  it("具体的な期日は捨てて不足点へ回し、既存Issue番号を含む題は使わない", () => {
    const r = parse({
      recommended: "post_release",
      drafts: { ...drafts, post_release: { reason: "後で", timing: "2026年11月1日まで", followUpTitle: "#4651 の続き" } },
    }).get("R-000001");
    expect(r?.drafts.post_release.timing).toBeNull();
    expect(r?.drafts.post_release.followUpTitle).toBeNull();
    expect(r?.missing.join("\n")).toContain("期日は決まっていません");
    expect(r?.missing.join("\n")).toContain("既存の関連Issueは確認していません");
  });
});

describe("oneTapBlocker", () => {
  it("必須項目が理由案に揃っていればワンタップで確定できる", () => {
    expect(oneTapBlocker(rec())).toBeNull();
    expect(oneTapBlocker(rec({ recommended: "defer" }))).toBeNull();
    expect(oneTapBlocker(rec({ recommended: "post_release" }))).toBeNull();
  });

  it("公開後対応で追跡先の案が無い・見送りで残る影響が無いときは、フォームで埋めてもらう", () => {
    const base = rec();
    const noTitle = rec({ recommended: "post_release", drafts: { ...base.drafts, post_release: { ...base.drafts.post_release, followUpTitle: null } } });
    expect(oneTapBlocker(noTitle)).toContain("追跡するIssue");
    const noImpact = rec({ recommended: "defer", drafts: { ...base.drafts, defer: { ...base.drafts.defer, impact: null } } });
    expect(oneTapBlocker(noImpact)).toContain("残る影響");
  });

  it("公開後対応の追跡先は新しいIssueの作成だけを送る（既存番号を作らない）", () => {
    const input = draftToDecisionInput("post_release", rec().drafts.post_release);
    expect(input.followUp).toEqual({ kind: "create", title: "移行手順を追記する" });
    expect(draftToDecisionInput("fix_now", rec().drafts.fix_now).followUp).toBeNull();
  });
});

describe("理由の出どころと採否の表示", () => {
  it("AIの理由案のまま／編集／推奨なしを区別する", () => {
    const r = rec();
    expect(classifyReasonSource(r, "fix_now", " 公開前に直す ")).toBe("ai");
    expect(classifyReasonSource(r, "fix_now", "公開前に直す。補足")).toBe("ai_edited");
    expect(classifyReasonSource(null, "fix_now", "公開前に直す")).toBe("manual");
    expect(classifyReasonSource(r, "withdrawn", "撤回")).toBe("manual");
  });

  it("推奨と同じ判断か、異なる判断かを出す。推奨が無かった判断には出さない", () => {
    expect(describeAdoption({ decision: "defer", recommendedDecision: "defer", reasonSource: "ai" })?.label).toBe("AI推奨を採用");
    expect(describeAdoption({ decision: "defer", recommendedDecision: "defer", reasonSource: "ai_edited" })?.label).toBe("推奨を編集して採用");
    expect(describeAdoption({ decision: "fix_now", recommendedDecision: "defer", reasonSource: "ai" })?.label).toBe("AI推奨と異なる判断");
    expect(describeAdoption({ decision: "fix_now", recommendedDecision: null, reasonSource: null })).toBeNull();
  });
});

describe("buildRecommendationPrompt", () => {
  it("指摘の影響・根拠と、前提が変わった前回の判断を渡し、捏造の禁止を明示する", () => {
    const prompt = buildRecommendationPrompt({
      repoFullName: "o/r",
      prNumber: 6,
      findings: [
        {
          id: "R-000001",
          title: "再編集で変更が消える",
          detail: "d",
          severity: "high",
          file: "queue.ts",
          line: 142,
          impact: "後の編集が失われる",
          evidence: "完了時に置き換え",
          recommendation: null,
          pullRequests: [12],
          blocking: true,
          previousDecision: { decision: "defer", reason: "まれ", stale: "重大度が上がりました" },
        },
      ],
    });
    expect(prompt).toContain("後の編集が失われる");
    expect(prompt).toContain("queue.ts:142");
    expect(prompt).toContain("重大度が上がりました");
    expect(prompt).toContain("既存のIssue番号を書かない");
    expect(prompt).toContain("具体的な期日（日付）を書かない");
  });
});
