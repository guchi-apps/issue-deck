import { describe, expect, it } from "vitest";

import { RELEASE_REVIEW_CHECKLIST_VERSION, RELEASE_REVIEW_CHECK_ITEMS } from "./release-review-checklist";
import {
  normalizeReleaseReview,
  reviewFindingId,
  type ReleaseReviewNormalizeContext,
} from "./release-review-result";

const allChecks = (over: Record<string, Record<string, unknown>> = {}) =>
  RELEASE_REVIEW_CHECK_ITEMS.map((i) => ({ id: i.id, status: "confirmed", evidence: "確認した", ...over[i.id] }));
const fullChecks = (extra: Record<string, unknown> = {}) => ({
  state: "passed",
  checklistVersion: RELEASE_REVIEW_CHECKLIST_VERSION,
  checks: allChecks(),
  ...extra,
});

const names = (n: number) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
/** n個の対象のうち、先頭`reviewed`個を根拠つきで確認した実績 */
const coverageOf = (n: number, reviewed = n, extra: Record<string, unknown> = {}) => ({
  totalFiles: n,
  targetFiles: names(n),
  inputFiles: n,
  fileReviews: names(reviewed).map((file) => ({ file, status: "reviewed", evidence: "差分と呼び出し元を確認" })),
  ...extra,
});

const PREV_FINDING = { id: reviewFindingId({ title: "設定漏れ", file: "a.ts", line: 3 }), title: "設定漏れ", file: "a.ts", line: 3, detail: "env", occurrences: 1 };
const rereviewContext = (over: Partial<ReleaseReviewNormalizeContext> = {}): ReleaseReviewNormalizeContext => ({
  mode: "rereview",
  fullReviewReason: null,
  previous: {
    prNumber: 10,
    baseSha: "b",
    headSha: "oldhead",
    statuses: Object.fromEntries(RELEASE_REVIEW_CHECK_ITEMS.map((i) => [i.id, "confirmed" as const])),
    runFailed: false,
  },
  previousFindings: [PREV_FINDING],
  ...over,
});

describe("normalizeReleaseReview", () => {
  it("指摘も未確認範囲も無ければpassed", () => {
    const r = normalizeReleaseReview({ ...fullChecks(), summary: "問題なし", ...coverageOf(10) });
    expect(r).toMatchObject({ state: "passed", unverifiedScope: null });
    expect(r?.detail.reviewedFiles).toBe(10);
  });

  it("旧ランナーの結果（項目別の記録なし）はpassedでも未確認範囲つきになり、ゲートで止まる", () => {
    const r = normalizeReleaseReview({ state: "passed", summary: "問題なし", ...coverageOf(10) });
    expect(r?.state).toBe("passed");
    expect(r?.unverifiedScope).toContain("項目別の確認記録がありません");
    expect(r?.detail.review?.legacy).toBe(true);
  });

  it("指摘が1件でもあればneeds_check（AIのLGTMだけで通さない）", () => {
    const r = normalizeReleaseReview({
      state: "passed",
      findings: [{ severity: "high", title: "設定漏れ", detail: "env", file: "a.ts", pullRequests: [3, 3, 4] }],
    });
    expect(r?.state).toBe("needs_check");
    expect(r?.detail.affectedPullRequests).toEqual([3, 4]);
  });

  it("確認できたファイルが差分より少なければ未確認範囲を付けてpassedのまま持つ", () => {
    const r = normalizeReleaseReview({ state: "passed", ...coverageOf(80, 30) });
    expect(r?.state).toBe("passed");
    expect(r?.unverifiedScope).toContain("80ファイルのうち30");
    expect(r?.detail.coverage).toMatchObject({ reviewed: 30, unreviewed: 50, unreadable: 0 });
  });

  describe("確認実績（#4615）", () => {
    it("入力へ載せた件数（reviewedFiles）を申告しても、確認実績にはならない（113/120の再発防止）", () => {
      const r = normalizeReleaseReview(
        fullChecks({ totalFiles: 120, reviewedFiles: 113, inputFiles: 113, targetFiles: names(120), fileReviews: [] }),
      );
      expect(r?.detail.reviewedFiles).toBe(0);
      expect(r?.detail.coverage).toMatchObject({ inputFiles: 113, reviewed: 0, unreviewed: 120 });
      expect(r?.unverifiedScope).toContain("120ファイルのうち0");
    });

    it("入力に含まれていても根拠の無い・未読の対象は未確認になる", () => {
      const r = normalizeReleaseReview(
        fullChecks({
          ...coverageOf(3, 0),
          fileReviews: [
            { file: "src/f0.ts", status: "reviewed", evidence: "" },
            { file: "src/f1.ts", status: "reviewed", evidence: "読んだ" },
          ],
        }),
      );
      expect(r?.detail.coverage).toMatchObject({ reviewed: 1, unreviewed: 2 });
    });

    it("別バッチで確認した省略分は実績に数え、120ファイル全てが確認済みなら未確認範囲が無い", () => {
      const r = normalizeReleaseReview(fullChecks(coverageOf(120, 120, { inputFiles: 113, batches: 2 })));
      expect(r?.unverifiedScope).toBeNull();
      expect(r?.detail).toMatchObject({ reviewedFiles: 120, totalFiles: 120 });
      expect(r?.detail.coverage).toMatchObject({ inputFiles: 113, batches: 2 });
    });

    it("取得不能は省略と区別し、確認済みの記録があっても確認済みにしない。対象外のファイルは数えない", () => {
      const r = normalizeReleaseReview(
        fullChecks({
          ...coverageOf(4, 2),
          fileReviews: [
            { file: "src/f0.ts", status: "reviewed", evidence: "読んだ" },
            { file: "src/f1.ts", status: "reviewed", evidence: "読んだ" },
            { file: "src/f1.ts", status: "unreadable", evidence: "後半を取得できない" },
            { file: "other.ts", status: "reviewed", evidence: "対象外" },
          ],
        }),
      );
      expect(r?.detail.coverage).toMatchObject({ reviewed: 1, unreadable: 1, unreviewed: 2 });
      expect(r?.detail.coverage?.open.map((o) => o.kind)).toEqual(["unreadable", "unreviewed", "unreviewed"]);
      expect(r?.unverifiedScope).toContain("取得不能1");
    });

    it("中断で残ったバッチ数を未確認範囲へ出す", () => {
      const r = normalizeReleaseReview(fullChecks(coverageOf(10, 6, { pendingBatches: 2 })));
      expect(r?.unverifiedScope).toContain("残り2バッチ");
    });

    it("ファイル別の実績を持たない旧結果は件数不明（reviewedFiles=null）として扱う", () => {
      const r = normalizeReleaseReview(fullChecks({ reviewedFiles: 120, totalFiles: 120 }));
      expect(r?.detail.reviewedFiles).toBeNull();
      expect(r?.detail.coverage).toBeNull();
      expect(r?.unverifiedScope).toContain("確認済みの件数は不明");
    });
  });

  it("failedはそのまま、不正な状態・本文はnull", () => {
    expect(normalizeReleaseReview({ state: "failed" })?.state).toBe("failed");
    expect(normalizeReleaseReview({ state: "weird" })).toBeNull();
    expect(normalizeReleaseReview(null)).toBeNull();
  });

  it("止めない提案だけならpassed（リリースを止めない）。highは提案にできない", () => {
    const r = normalizeReleaseReview(
      fullChecks({
        findings: [
          { blocking: false, severity: "low", title: "文言を直したい" },
          { blocking: false, severity: "high", title: "認可の抜け", impact: "他リポジトリのデータが読める" },
        ],
      }),
    );
    expect(r?.detail.suggestions.map((f) => f.title)).toEqual(["文言を直したい"]);
    expect(r?.detail.findings.map((f) => f.title)).toEqual(["認可の抜け"]);
    expect(r?.state).toBe("needs_check");
    const onlySuggestion = normalizeReleaseReview(fullChecks({ findings: [{ blocking: false, severity: "low", title: "提案" }] }));
    expect(onlySuggestion?.state).toBe("passed");
    expect(onlySuggestion?.unverifiedScope).toBeNull();
  });

  it("必須項目の未確認・根拠なし・報告漏れは合格にしない", () => {
    const r = normalizeReleaseReview(
      fullChecks({ checks: allChecks({ host_compat: { status: "unconfirmed", evidence: "pollerを読めていない" }, auth_boundary: { evidence: "" } }).slice(0, 5) }),
    );
    expect(r?.state).toBe("passed");
    expect(r?.unverifiedScope).toMatch(/確認項目\d件が未確認/);
    expect(r?.detail.review?.checks.filter((c) => c.status === "unconfirmed")).toHaveLength(3);
  });

  it("差分の入力省略があれば、項目が確認済みでも未確認範囲が付く", () => {
    const r = normalizeReleaseReview(fullChecks(coverageOf(9, 3)));
    expect(r?.unverifiedScope).toContain("9ファイルのうち3");
  });

  it("確認項目の版が違う結果は全項目を未確認にする", () => {
    const r = normalizeReleaseReview(fullChecks({ checklistVersion: 99 }));
    expect(r?.unverifiedScope).toContain("版が一致しません");
    expect(r?.detail.review?.checks.every((c) => c.status === "unconfirmed")).toBe(true);
  });

  describe("再レビュー", () => {
    it("引き継ぎは前回に確認済みだった項目にだけ認め、旧SHAを明記する", () => {
      const r = normalizeReleaseReview(
        fullChecks({
          checks: allChecks({ auth_boundary: { source: "carried_over", evidence: "認可に関わるファイルは前回から変更なし" } }),
          previousFindings: [{ id: PREV_FINDING.id, status: "resolved", evidence: "修正PRで対応を確認" }],
        }),
        rereviewContext(),
      );
      const carried = r?.detail.review?.checks.find((c) => c.id === "auth_boundary");
      expect(carried).toMatchObject({ source: "carried_over", carriedFromHeadSha: "oldhead", status: "confirmed" });
      expect(r?.detail.review?.mode).toBe("rereview");
      expect(r?.state).toBe("passed");
      expect(r?.unverifiedScope).toBeNull();
    });

    it("base変更・履歴不明などで再レビューが成立しないときは、引き継ぎの申告を認めない", () => {
      const r = normalizeReleaseReview(
        fullChecks({ checks: allChecks({ auth_boundary: { source: "carried_over" } }) }),
        rereviewContext({ mode: "initial", fullReviewReason: "mainの先端（base）が変わったため、対象全体を確認します" }),
      );
      expect(r?.detail.review?.mode).toBe("initial");
      expect(r?.detail.review?.checks.find((c) => c.id === "auth_boundary")?.status).toBe("unconfirmed");
      expect(r?.unverifiedScope).toContain("未確認");
    });

    it("ランナーが実測した追加PRなどで全体確認へ戻された場合も引き継ぎを認めない", () => {
      const r = normalizeReleaseReview(
        fullChecks({
          fullReviewReason: "修正と無関係なPR（#99）が加わったため、対象全体を確認します",
          checks: allChecks({ auth_boundary: { source: "carried_over" } }),
        }),
        rereviewContext(),
      );
      expect(r?.detail.review?.mode).toBe("initial");
      expect(r?.detail.review?.fullReviewReason).toContain("#99");
    });

    it("前回に未確認だった項目は引き継げない", () => {
      const ctx = rereviewContext();
      ctx.previous!.statuses.host_compat = "unconfirmed";
      const r = normalizeReleaseReview(
        fullChecks({ checks: allChecks({ host_compat: { source: "carried_over" } }) }),
        ctx,
      );
      expect(r?.detail.review?.checks.find((c) => c.id === "host_compat")?.status).toBe("unconfirmed");
    });

    it("同じ指摘の再発と新規指摘を区別し、新規には発見理由を残す", () => {
      const r = normalizeReleaseReview(
        fullChecks({
          fixDiffFiles: ["a.ts"],
          findings: [
            { severity: "high", title: "設定漏れ（言い換え）", file: "a.ts", line: 3, previousId: PREV_FINDING.id, impact: "i", evidence: "e" },
            { severity: "high", title: "再試行で二重実行", file: "b.ts", discovery: "fix_induced", impact: "i", evidence: "e" },
          ],
          previousFindings: [{ id: PREV_FINDING.id, status: "unresolved", evidence: "まだ残っている" }],
        }),
        rereviewContext(),
      );
      const [recurring, fresh] = r!.detail.findings;
      expect(recurring).toMatchObject({ id: PREV_FINDING.id, status: "recurring", occurrences: 2, stallCause: "fix_ineffective" });
      expect(fresh).toMatchObject({ status: "new", discovery: "fix_induced", occurrences: 1 });
      expect(r?.state).toBe("needs_check");
    });

    it("修正差分が指摘のファイルへ届いていなければ未修正、前回の実行が失敗していれば実行障害", () => {
      const finding = { severity: "high", title: "設定漏れ", file: "a.ts", line: 3, impact: "i", evidence: "e" };
      const unfixed = normalizeReleaseReview(
        fullChecks({ fixDiffFiles: ["z.ts"], findings: [finding], previousFindings: [{ id: PREV_FINDING.id, status: "unresolved", evidence: "残" }] }),
        rereviewContext(),
      );
      expect(unfixed?.detail.findings[0].stallCause).toBe("unfixed");
      const ctx = rereviewContext();
      ctx.previous!.runFailed = true;
      const failedBefore = normalizeReleaseReview(fullChecks({ findings: [finding] }), ctx);
      expect(failedBefore?.detail.findings[0].stallCause).toBe("execution_failure");
    });

    it("根拠の無い「解消」は未確認、未解消と報告されたのに指摘が無ければ指摘へ戻す", () => {
      const noEvidence = normalizeReleaseReview(
        fullChecks({ previousFindings: [{ id: PREV_FINDING.id, status: "resolved" }] }),
        rereviewContext(),
      );
      expect(noEvidence?.detail.review?.previousFindings[0].status).toBe("not_checked");
      expect(noEvidence?.unverifiedScope).toContain(PREV_FINDING.id);
      const dropped = normalizeReleaseReview(
        fullChecks({ previousFindings: [{ id: PREV_FINDING.id, status: "unresolved", evidence: "残っている" }] }),
        rereviewContext(),
      );
      expect(dropped?.detail.findings).toHaveLength(1);
      expect(dropped?.detail.findings[0]).toMatchObject({ id: PREV_FINDING.id, status: "recurring" });
      expect(dropped?.state).toBe("needs_check");
    });

    it("前回の指摘が報告から漏れていれば、解消済みとは扱わず未確認にする", () => {
      const r = normalizeReleaseReview(fullChecks(), rereviewContext());
      expect(r?.detail.review?.previousFindings[0].status).toBe("not_checked");
      expect(r?.unverifiedScope).toContain("解消を確認できていません");
    });
  });

  it("タイトルの無い指摘は捨てる", () => {
    const r = normalizeReleaseReview({ state: "passed", findings: [{ detail: "x" }, "bad"] });
    expect(r?.detail.findings).toEqual([]);
  });
});
