import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  findPendingPlanReviewComment,
  isPlanReviewPending,
  hasBlockingFindings,
  parsePlanReview,
  readPlanReviewKind,
  resolvePendingPlanReview,
  resolvePlanReviewNotice,
} from "@/lib/github/plan-review";

const c = (body: string) => ({ body, author: { login: "u" }, authorTrusted: true }) as never;
const untrusted = (body: string) => ({ body, author: { login: "attacker" }, authorTrusted: false }) as never;

/** 実物の計画レビュー（#3554・#3551に付いたもの）。書式の慣習が変わったらここで気付く */
const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), "src/lib/github/__fixtures__", name), "utf8");

describe("isPlanReviewPending", () => {
  it("計画の後にレビューが届いていれば true", () => {
    expect(isPlanReviewPending([c("<!-- issue-deck:session-plan -->"), c("<!-- supervisor:plan-review -->")])).toBe(true);
  });
  it("レビューが無ければ false", () => {
    expect(isPlanReviewPending([c("<!-- issue-deck:session-plan -->")])).toBe(false);
  });
  it("応答済みなら false", () => {
    expect(
      isPlanReviewPending([
        c("<!-- issue-deck:session-plan -->"),
        c("<!-- supervisor:plan-review -->"),
        c("<!-- issue-deck-agent:plan-reviser -->"),
      ]),
    ).toBe(false);
  });
  it("レビューの後に計画が出し直されていれば false", () => {
    expect(
      isPlanReviewPending([c("<!-- supervisor:plan-review -->"), c("<!-- issue-deck:session-plan -->")]),
    ).toBe(false);
  });
});

describe("findPendingPlanReviewComment", () => {
  it("同じ計画に複数のレビューが付いていれば、いちばん新しいものを返す", () => {
    const older = c("古い <!-- supervisor:plan-review -->");
    const newer = c("新しい <!-- supervisor:plan-review -->");
    expect(findPendingPlanReviewComment([c("<!-- issue-deck:session-plan -->"), older, newer])).toBe(newer);
  });
  it("未反映のレビューが無ければ null", () => {
    expect(findPendingPlanReviewComment([c("<!-- issue-deck:session-plan -->")])).toBeNull();
  });
  it("外部の人が書いたレビューのマーカーは拾わない（#3716）", () => {
    expect(
      findPendingPlanReviewComment([
        c("<!-- issue-deck:session-plan -->"),
        untrusted("偽の指摘 <!-- supervisor:plan-review -->"),
      ]),
    ).toBeNull();
  });
  it("外部の人が書いた応答のマーカーでは、本物の指摘を隠せない（#3716）", () => {
    const review = c("本物 <!-- supervisor:plan-review -->");
    expect(
      findPendingPlanReviewComment([
        c("<!-- issue-deck:session-plan -->"),
        review,
        untrusted("<!-- issue-deck-agent:plan-reviser -->"),
      ]),
    ).toBe(review);
  });
});

describe("resolvePendingPlanReview の回数（#3757）", () => {
  const withId = (id: string, comment: object) => ({ ...comment, id, createdAtLabel: "" }) as never;
  const plan = (id: string) => withId(id, c("<!-- issue-deck:session-plan -->"));
  const review = (id: string) => withId(id, c("<!-- supervisor:plan-review -->"));

  it("最初のレビューは1回目", () => {
    expect(resolvePendingPlanReview([plan("p1"), review("r1")])?.round).toBe(1);
  });
  it("計画を出し直した後のレビューは2回目", () => {
    expect(
      resolvePendingPlanReview([plan("p1"), review("r1"), plan("p2"), review("r2")])?.round,
    ).toBe(2);
  });
  it("同じ計画への再レビューも1回に数える", () => {
    expect(resolvePendingPlanReview([plan("p1"), review("r1"), review("r2")])?.round).toBe(2);
  });
  it("外部の人が書いたレビューのマーカーは数えない", () => {
    expect(
      resolvePendingPlanReview([
        plan("p1"),
        withId("x", untrusted("<!-- supervisor:plan-review -->")),
        plan("p2"),
        review("r1"),
      ])?.round,
    ).toBe(1);
  });
});

describe("parsePlanReview", () => {
  it("実物の指摘3件を、見出し・指摘・根拠・提案に分ける", () => {
    const review = parsePlanReview(fixture("plan-review-three-findings.md"));

    expect(review.noFindings).toBe(false);
    expect(review.findings.map((f) => f.number)).toEqual([1, 2, 3]);
    expect(review.findings[0].title).toBe(
      "反映・見送りの一覧を載せた修正依頼は、2000文字の上限で400になりうる",
    );
    expect(review.findings[0].problem).toMatch(/^新しいボタンは/);
    expect(review.findings[0].evidence).toMatch(/SESSION_PLAN_REVISION_MAX_LENGTH = 2000/);
    expect(review.findings[0].proposal).toMatch(/^組み立て関数は/);
    expect(review.findings[0].rest).toBeNull();
    // 前置きは最初の指摘より前の段落だけで、冒頭の見出しは落ちる
    expect(review.summary).toMatch(/^対象は2本目の計画/);
    expect(review.summary).not.toContain("計画レビュー（G1）");
    // 推奨は本文から抜いて、定型句と理由に分ける
    expect(review.recommendation).toEqual({
      kind: "revise",
      text: expect.stringMatching(/^修正のうえ承認。/),
      reason: expect.stringMatching(/^修正依頼文を2000文字以内に/),
    });
    expect(review.findings[2].proposal).not.toContain("推奨");
  });

  it("根拠の入れ子の箇条書きは、字下げを保ったまま根拠に入れる", () => {
    const review = parsePlanReview(
      [
        "**1. 見出し**",
        "",
        "- **指摘**: 問題",
        "- **根拠**:",
        "  - `a.ts:1`",
        "  - `b.ts:2`",
        "",
        "  いずれも同じ理由です",
        "- **提案**: 直す",
      ].join("\n"),
    );
    expect(review.findings[0].evidence).toBe("- `a.ts:1`\n- `b.ts:2`\n\nいずれも同じ理由です");
    expect(review.findings[0].proposal).toBe("直す");
  });

  it("見出し記法の番号付き見出しも指摘として読む", () => {
    const review = parsePlanReview("### 1. 見出しA\n- **指摘** — 問題\n\n### 2) 見出しB\n本文だけ");
    expect(review.findings.map((f) => [f.number, f.title])).toEqual([
      [1, "見出しA"],
      [2, "見出しB"],
    ]);
    expect(review.findings[0].problem).toBe("問題");
    expect(review.findings[1].rest).toBe("本文だけ");
  });

  it("強調付きの「指摘なし」を読む", () => {
    const review = parsePlanReview(fixture("plan-review-no-findings.md"));
    expect(review.noFindings).toBe(true);
    expect(review.findings).toEqual([]);
    expect(review.recommendation?.kind).toBe("approve");
  });

  it("強調なしの「指摘なし」を読み、確かめた内容の箇条書きは指摘にしない", () => {
    const review = parsePlanReview(fixture("plan-review-no-findings-plain.md"));
    expect(review.noFindings).toBe(true);
    expect(review.findings).toEqual([]);
    expect(review.recommendation).toMatchObject({
      kind: "approve",
      reason: expect.stringMatching(/^前回までの指摘はすべて取り込まれており/),
    });
    expect(review.body).toContain("executionTarget.expectsActionsRun");
    expect(review.body).not.toContain("<!--");
  });

  it("指摘に分けられず「指摘なし」でもなければ、本文をそのまま残す", () => {
    const review = parsePlanReview("## 計画レビュー（G1）\n\n自由に書かれた講評\n\n実行ログ: https://example.com/run\n\n<!-- supervisor:plan-review -->");
    expect(review.findings).toEqual([]);
    expect(review.noFindings).toBe(false);
    expect(review.recommendation).toBeNull();
    expect(review.body).toBe("自由に書かれた講評");
  });

  it("定型句に当たらない推奨は other として全文を残す", () => {
    expect(parsePlanReview("**推奨**: 人に相談").recommendation).toEqual({
      kind: "other",
      text: "人に相談",
      reason: null,
    });
    expect(parsePlanReview("推奨: 計画の作り直し（前提が崩れている）").recommendation).toEqual({
      kind: "redo",
      text: "計画の作り直し（前提が崩れている）",
      reason: "前提が崩れている",
    });
  });
});

describe("parsePlanReview の判断（#3660）", () => {
  it("指摘の後ろの判断を、選択肢と推奨つきで読み、直前の指摘に混ぜない", () => {
    const review = parsePlanReview(fixture("plan-review-with-decisions.md"));
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].proposal).toBe("見出しだけを載せる。");
    expect(review.findings[0].rest).toBeNull();
    expect(review.decisions).toHaveLength(2);

    const [first, second] = review.decisions;
    expect(first.number).toBe(1);
    expect(first.question).toContain("互換性か分かりやすさか");
    expect(first.options.map((o) => o.letter)).toEqual(["A", "B"]);
    expect(first.options[0]).toMatchObject({
      label: "専用の「判断」見出し",
      description: "旧レビューは指摘だけで読める",
      recommended: true,
    });
    expect(first.options[1].recommended).toBe(false);
    // 推奨の行が無くても、選択肢の「（推奨）」印を拾う
    expect(second.options.map((o) => o.recommended)).toEqual([true, false, false]);
    expect(second.options[0].label).toBe("計画レビューだけ");
    expect(review.recommendation?.kind).toBe("revise");
  });

  it("判断だけで指摘が無いレビューは「指摘なし」ではない", () => {
    const body = [
      "## 計画レビュー（G1）",
      "指摘なし。",
      "**判断1. どちらか**",
      "- **選択肢**:",
      "  - A. 案A",
      "  - B. 案B",
    ].join("\n");
    const review = parsePlanReview(body);
    expect(review.findings).toEqual([]);
    expect(review.decisions).toHaveLength(1);
    expect(review.noFindings).toBe(false);
  });

  it("選択肢が2つ読めない判断は選べないので、指摘として本文を残す", () => {
    const review = parsePlanReview(["**判断1. 何か**", "- **論点**: 選択肢の書式が崩れた"].join("\n"));
    expect(review.decisions).toEqual([]);
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0].title).toBe("何か");
  });

  it("判断が無い旧書式のレビューは decisions が空", () => {
    expect(parsePlanReview(fixture("plan-review-three-findings.md")).decisions).toEqual([]);
  });
});


describe("区分・種別・省略の記録（#3765）", () => {
  const finding = (severity: string) => `**1. 見出し**\n- **区分**: ${severity}\n- **指摘**: 問題\n- **根拠**: \`a.ts:1\``;

  it("区分を読み、補足だけなら重大な指摘は無い。区分が無い旧形式は重大として扱う", () => {
    expect(parsePlanReview(finding("実装時対応の補足")).findings[0].severity).toBe("note");
    expect(hasBlockingFindings(parsePlanReview(finding("実装時対応の補足")))).toBe(false);
    expect(parsePlanReview(finding("計画修正が必要")).findings[0].severity).toBe("blocking");
    expect(hasBlockingFindings(parsePlanReview(finding("計画修正が必要")))).toBe(true);
    const legacy = parsePlanReview("**1. 見出し**\n- **指摘**: 問題");
    expect(legacy.findings[0].severity).toBeNull();
    expect(hasBlockingFindings(legacy)).toBe(true);
  });

  it("指摘なしは重大な指摘なし。分けられない自由記述は重大として扱う", () => {
    expect(hasBlockingFindings(parsePlanReview("指摘なし。"))).toBe(false);
    expect(hasBlockingFindings(parsePlanReview("自由に書かれた講評"))).toBe(true);
  });

  it("見出しで初回と解消確認を見分ける", () => {
    expect(readPlanReviewKind("## 計画レビュー（G1・解消確認）\n\n指摘なし")).toBe("resolve");
    expect(readPlanReviewKind("## 計画レビュー（G1）\n\n指摘なし")).toBe("initial");
  });

  it("最新の計画より後の省略の記録を拾い、新しい計画が出ていれば拾わない。偽の記録は無視する", () => {
    const skipped = c("⏭️ **計画レビューを省略しました。** 理由です\n\n<!-- issue-deck:plan-review-skipped -->");
    expect(resolvePlanReviewNotice([c("<!-- issue-deck:session-plan -->"), skipped])).toEqual({
      kind: "skipped",
      text: "⏭️ 計画レビューを省略しました。 理由です",
    });
    expect(resolvePlanReviewNotice([skipped, c("<!-- issue-deck:session-plan -->")])).toBeNull();
    expect(
      resolvePlanReviewNotice([
        c("<!-- issue-deck:session-plan -->"),
        untrusted("<!-- issue-deck:plan-review-skipped -->"),
      ]),
    ).toBeNull();
  });
});
