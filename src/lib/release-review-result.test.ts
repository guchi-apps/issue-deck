import { describe, expect, it } from "vitest";

import { RELEASE_REVIEW_CHECKLIST_VERSION, RELEASE_REVIEW_CHECK_ITEMS } from "./release-review-checklist";
import {
  decideFindingBlocking,
  normalizeReleaseReview,
  normalizeReviewPath,
  reviewFindingId,
  type FindingBlockingInput,
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

  it("旧ランナー（版なし）の指摘はフラグが無くても従来どおり止める指摘（needs_check）", () => {
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
    it("パスは揃えてから照合する（「./」・先頭の「/」・区切りの揺れだけで未確認にしない。#4768）", () => {
      expect(normalizeReviewPath("./src/a.ts")).toBe("src/a.ts");
      expect(normalizeReviewPath("/src/a.ts")).toBe("src/a.ts");
      expect(normalizeReviewPath("src\\lib\\a.ts")).toBe("src/lib/a.ts");
      expect(normalizeReviewPath(" src//lib/./a.ts ")).toBe("src/lib/a.ts");
      const r = normalizeReleaseReview(
        fullChecks({
          totalFiles: 3,
          targetFiles: ["./src/f0.ts", "src/f1.ts", "src/f2.ts"],
          inputFiles: 3,
          fileReviews: [
            { file: "src/f0.ts", status: "reviewed", evidence: "読んだ" },
            { file: "./src/f1.ts", status: "reviewed", evidence: "読んだ" },
            { file: "/src\\f2.ts", status: "reviewed", evidence: "読んだ" },
          ],
          supplementedFiles: 1,
        }),
      );
      expect(r?.detail.coverage).toMatchObject({ reviewed: 3, unreviewed: 0, supplementedFiles: 1 });
      expect(r?.unverifiedScope).toBeNull();
    });

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

    it("保存済みの結果の再利用（再利用・再確認のバッチ数）を記録として残す（#4767）", () => {
      const r = normalizeReleaseReview(
        fullChecks(coverageOf(10, 10, { batches: 3, reusedBatches: 2, rerunBatches: 1, integrationReused: false })),
      );
      expect(r?.detail.coverage).toMatchObject({ reusedBatches: 2, rerunBatches: 1, integrationReused: false });
      const legacy = normalizeReleaseReview(fullChecks(coverageOf(10, 10)));
      expect(legacy?.detail.coverage).toMatchObject({ reusedBatches: 0, rerunBatches: 0, integrationReused: null });
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

  it("止めない提案だけならpassed（リリースを止めない）。highでも提案にできるが、セキュリティ相当は止める", () => {
    const r = normalizeReleaseReview(
      fullChecks({
        findings: [
          { blocking: false, severity: "low", title: "文言を直したい" },
          { blocking: false, severity: "high", title: "念のための再試行確認" },
          { blocking: false, severity: "high", title: "認可の抜け", checkId: "auth_boundary", impact: "他リポジトリのデータが読める" },
        ],
      }),
    );
    expect(r?.detail.suggestions.map((f) => f.title)).toEqual(["文言を直したい", "念のための再試行確認"]);
    expect(r?.detail.findings.map((f) => f.title)).toEqual(["認可の抜け"]);
    expect(r?.detail.findings[0].checkId).toBe("auth_boundary");
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
            { blocking: true, blockingReason: "r", severity: "high", title: "設定漏れ（言い換え）", file: "a.ts", line: 3, previousId: PREV_FINDING.id, impact: "i", evidence: "e" },
            { blocking: true, blockingReason: "r", severity: "high", title: "再試行で二重実行", file: "b.ts", discovery: "fix_induced", impact: "i", evidence: "e" },
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
      const finding = { blocking: true, blockingReason: "r", severity: "high", title: "設定漏れ", file: "a.ts", line: 3, impact: "i", evidence: "e" };
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

describe("ユーザー判断の引き継ぎ（#4657）", () => {
  const decidedCtx = () => rereviewContext({ previousFindings: [], decidedFindingIds: [PREV_FINDING.id] });

  it("判断済みの指摘を言い換えて出し直しても、previousIdで同じIDへ戻す（判断が外れない）", () => {
    const r = normalizeReleaseReview(
      fullChecks({
        findings: [{ blocking: true, blockingReason: "r", severity: "high", title: "フリート未配布（言い換え）", file: "x.ts", previousId: PREV_FINDING.id, impact: "i", evidence: "e" }],
      }),
      decidedCtx(),
    );
    expect(r?.detail.findings[0]).toMatchObject({ id: PREV_FINDING.id, status: "recurring" });
    expect(r?.detail.findings[0].premiseChanged ?? null).toBeNull();
  });

  it("前提の変化は判断済みの指摘にだけ付けられる", () => {
    const r = normalizeReleaseReview(
      fullChecks({
        findings: [
          { blocking: true, blockingReason: "r", severity: "high", title: "設定漏れ", file: "a.ts", line: 3, premiseChanged: "配布手順が変わった", impact: "i", evidence: "e" },
          { blocking: true, blockingReason: "r", severity: "high", title: "別の指摘", file: "b.ts", premiseChanged: "勝手な申告", impact: "i", evidence: "e" },
        ],
      }),
      decidedCtx(),
    );
    expect(r?.detail.findings[0]).toMatchObject({ id: PREV_FINDING.id, premiseChanged: "配布手順が変わった" });
    expect(r?.detail.findings[1].premiseChanged).toBeUndefined();
  });

  it("判断済みの指摘は、前回の指摘の解消確認・未解消の再注入の対象にならない", () => {
    const r = normalizeReleaseReview(fullChecks({ previousFindings: [{ id: PREV_FINDING.id, status: "unresolved", evidence: "残" }] }), decidedCtx());
    expect(r?.detail.findings).toHaveLength(0);
    expect(r?.unverifiedScope ?? "").not.toContain(PREV_FINDING.id);
    expect(r?.state).toBe("passed");
  });
});

describe("止める指摘の判定（#4765）", () => {
  const input = (over: Partial<FindingBlockingInput> = {}): FindingBlockingInput => ({
    requested: true,
    severity: "medium",
    legacy: false,
    security: false,
    file: "src/a.ts",
    impact: "利用者の設定が消える",
    evidence: "src/a.ts:10 で上書きしている",
    blockingReason: "データ破損",
    targetFiles: new Set(["src/a.ts", "src/b.ts"]),
    unrelatedInitialMiss: false,
    ...over,
  });

  it("差分内・根拠がそろった止める申告は維持する", () => {
    expect(decideFindingBlocking(input())).toEqual({ blocking: true, demotedReason: null });
  });

  it("申告が無い指摘は提案として扱い、理由を残す。明示の提案は理由を付けない", () => {
    expect(decideFindingBlocking(input({ requested: undefined }))).toMatchObject({ blocking: false, demotedReason: expect.stringContaining("申告") });
    expect(decideFindingBlocking(input({ requested: false, severity: "high" }))).toEqual({ blocking: false, demotedReason: null });
  });

  it("impact・evidence・blockingReasonの欠落は降格する", () => {
    const d = decideFindingBlocking(input({ impact: null, blockingReason: null }));
    expect(d.blocking).toBe(false);
    expect(d.demotedReason).toContain("impact・blockingReason");
  });

  it("差分外のファイルは、根拠が差分内のファイルを挙げていなければ降格し、挙げていれば維持する", () => {
    const outside = decideFindingBlocking(input({ file: "src/old.ts", evidence: "古い処理が残っている" }));
    expect(outside.blocking).toBe(false);
    expect(outside.demotedReason).toContain("src/old.ts");
    expect(decideFindingBlocking(input({ file: "src/old.ts", evidence: "src/b.ts の変更で呼び出し引数が変わった" })).blocking).toBe(true);
    // 対象ファイルが報告されていない結果では差分内かを確かめない
    expect(decideFindingBlocking(input({ file: "src/old.ts", targetFiles: null })).blocking).toBe(true);
  });

  it("修正差分に関係しない初回の見落としは降格する", () => {
    const d = decideFindingBlocking(input({ unrelatedInitialMiss: true }));
    expect(d).toMatchObject({ blocking: false, demotedReason: expect.stringContaining("初回の見落とし") });
  });

  it("セキュリティ相当は、申告・根拠・差分の有無にかかわらず止める指摘に固定する", () => {
    expect(
      decideFindingBlocking(
        input({ security: true, requested: false, impact: null, file: "src/old.ts", evidence: null, unrelatedInitialMiss: true }),
      ),
    ).toEqual({ blocking: true, demotedReason: null });
  });

  it("旧ランナー（版なし）は従来どおり: フラグ無しは止める、highは提案にできない", () => {
    expect(decideFindingBlocking(input({ legacy: true, requested: undefined, impact: null }))).toEqual({ blocking: true, demotedReason: null });
    expect(decideFindingBlocking(input({ legacy: true, requested: false, severity: "high" })).blocking).toBe(true);
    expect(decideFindingBlocking(input({ legacy: true, requested: false, severity: "low" })).blocking).toBe(false);
  });

  it("正規化では対象ファイル外の指摘を提案へ降格し、降格理由を記録する", () => {
    const r = normalizeReleaseReview(
      fullChecks({
        ...coverageOf(2),
        findings: [
          { blocking: true, severity: "high", title: "既存コードの問題", file: "src/legacy.ts", impact: "i", evidence: "既存の処理", blockingReason: "r" },
          { blocking: true, severity: "medium", title: "差分内の問題", file: "src/f0.ts", impact: "i", evidence: "e", blockingReason: "r" },
        ],
      }),
    );
    expect(r?.detail.findings.map((f) => f.title)).toEqual(["差分内の問題"]);
    expect(r?.detail.suggestions[0]).toMatchObject({ title: "既存コードの問題", blockingReason: null });
    expect(r?.detail.suggestions[0].demotedReason).toContain("src/legacy.ts");
    expect(r?.state).toBe("needs_check");
  });

  it("再レビューで修正差分に関係しないinitial_missは提案、修正差分のファイルなら維持、セキュリティ相当は止める", () => {
    const base = { blocking: true, severity: "high", impact: "i", evidence: "e", blockingReason: "r", discovery: "initial_miss" };
    const r = normalizeReleaseReview(
      fullChecks({
        fixDiffFiles: ["a.ts"],
        findings: [
          { ...base, title: "無関係な見落とし", file: "z.ts" },
          { ...base, title: "修正箇所の見落とし", file: "a.ts" },
          { ...base, title: "認可の見落とし", file: "z.ts", checkId: "auth_boundary" },
        ],
        previousFindings: [{ id: PREV_FINDING.id, status: "resolved", evidence: "直った" }],
      }),
      rereviewContext(),
    );
    expect(r?.detail.findings.map((f) => f.title)).toEqual(["修正箇所の見落とし", "認可の見落とし"]);
    expect(r?.detail.suggestions.map((f) => f.title)).toEqual(["無関係な見落とし"]);
    expect(r?.detail.suggestions[0].demotedReason).toContain("初回の見落とし");
  });

  it("前回の指摘が提案として載っていれば、止める指摘として再注入しない", () => {
    const r = normalizeReleaseReview(
      fullChecks({
        findings: [{ severity: "high", title: "設定漏れ", file: "a.ts", line: 3, previousId: PREV_FINDING.id }],
        previousFindings: [{ id: PREV_FINDING.id, status: "unresolved", evidence: "残" }],
      }),
      rereviewContext(),
    );
    expect(r?.detail.findings).toHaveLength(0);
    expect(r?.detail.suggestions[0]).toMatchObject({ id: PREV_FINDING.id, status: "recurring" });
    expect(r?.detail.review?.previousFindings[0].status).toBe("unresolved");
  });
});
