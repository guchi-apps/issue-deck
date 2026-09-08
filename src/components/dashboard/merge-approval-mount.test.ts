import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * マージ待ちの操作一式（レビュー本文・修正依頼欄）の置き場所（#2914）を守る。
 *
 * **Issue詳細はPC版（`issue-detail.tsx`）とスマホ版（`mobile/mobile-issue-detail.tsx`）で
 * 別のコンポーネント**なので、片方へ足しただけではもう片方が置き忘れになる
 * （`plan-approval-mount.test.ts`と同じ理由）。描画のテストで両方を確かめるには
 * それぞれのモック一式が要るため、**置き忘れと置き場所のずれだけを**ここで捕まえる。
 */
const DETAIL_SOURCES = [
  "src/components/dashboard/issue-detail.tsx",
  "src/components/dashboard/mobile/mobile-issue-detail.tsx",
] as const;

const COMMENT_THREAD = "src/components/dashboard/comment-thread.tsx";

describe("マージ待ちの操作一式の置き場所（#2914）", () => {
  it.each(DETAIL_SOURCES)("%s がレビュー本文と修正依頼欄を描く", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("<MergeApprovalActions");
  });

  /**
   * **対応PRセクションの中に置く**のがこの変更の要点。マージボタンと同じ枠に無いと、
   * 読む場所と押す場所がまた離れる（コメント欄の案内は「対応PRへ移動」で送るだけ）。
   */
  it.each(DETAIL_SOURCES)("%s は対応PRセクションの中に置く", (path) => {
    const source = readFileSync(path, "utf8");
    const sectionStart = source.indexOf('id="pull-requests"');
    const actions = source.indexOf("<MergeApprovalActions");
    const sectionEnd = source.indexOf("</IssueDetailSection>", sectionStart);
    expect(sectionStart).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(sectionStart);
    expect(actions).toBeLessThan(sectionEnd);
  });

  /** コメント欄の承認カードは行き先を示すだけ。同じ内容を2か所に出さない */
  it("コメント欄の承認カードはレビュー本文を描かない", () => {
    const source = readFileSync(COMMENT_THREAD, "utf8");
    expect(source).not.toContain("<PullRequestReviewFindings");
  });

  /** マージボタン（`IssuePullRequestList`）も上部だけが持つ */
  it("コメント欄の承認カードは対応PRの一覧を描かない", () => {
    const source = readFileSync(COMMENT_THREAD, "utf8");
    expect(source).not.toContain("<IssuePullRequestList");
  });
});

/**
 * 修正依頼の送り先を、PC版とスマホ版で同じに保つ（#2919）。
 *
 * 送り先の判定そのものは`resolvePrFixRequestRoute`が持ち、そちらは単体テストで押さえてある。
 * ここが捕まえるのは**片方の画面だけ判定を通していない／結果を渡し忘れている**形で、
 * 上の置き忘れと同じ種類の事故（同じIssueをスマホから開いたときだけ挙動が違う）。
 */
describe("修正依頼の送り先（#2919）", () => {
  it.each(DETAIL_SOURCES)("%s は送り先の判定を`resolvePrFixRequestRoute`に任せる", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("resolvePrFixRequestRoute({");
  });

  it.each(DETAIL_SOURCES)("%s は送り先とその状態を修正依頼欄へ渡す", (path) => {
    const source = readFileSync(path, "utf8");
    for (const prop of ["prFixRoute={prFixRoute}", "prFixSessionRejection=", "prFixSessionError="]) {
      expect(source).toContain(prop);
    }
  });

  /**
   * **呼び戻すときのCLIを渡し忘れない。** `POST /api/dispatch`は`agent`が無いと既定
   * （Claude Code）へ落とすため、書き忘れるとCodexで進んでいたIssueが黙って別のCLIで立ち上がる。
   */
  it.each(DETAIL_SOURCES)("%s は呼び戻すときに`agent`を引き継ぐ", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("agent: prFixRoute.agent");
  });
});
