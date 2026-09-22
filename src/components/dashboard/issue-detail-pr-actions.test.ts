import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Issue詳細がPRを変更する操作を持たないこと（#3333）を守る。
 *
 * **Issue詳細は「何を完了させるか」、PR詳細は「変更をどう統合するか」を扱う。** 以前は
 * Issue詳細の対応PR欄からもマージ・「マージしない」・修正依頼ができ、確認ダイアログと判定が
 * PR詳細と2系統に割れていた。**Issue詳細はPC版とスマホ版で別のコンポーネント**なので、
 * 片方へ戻しただけでも責務がまたずれる（`plan-approval-mount.test.ts`と同じ理由）。描画の
 * テストで両方を確かめるにはそれぞれのモック一式が要るため、ソースの形だけをここで捕まえる。
 */
const DETAIL_SOURCES = [
  "src/components/dashboard/issue-detail.tsx",
  "src/components/dashboard/mobile/mobile-issue-detail.tsx",
  "src/components/dashboard/comment-thread.tsx",
  "src/components/dashboard/issue-pull-request-list.tsx",
] as const;

const SHELL = "src/components/dashboard/issue-deck-shell.tsx";

describe("Issue詳細はPRを変更する操作を持たない（#3333）", () => {
  it.each(DETAIL_SOURCES)("%s はPRのマージ・クローズを呼ばない", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("usePullRequestMergeMutation");
    expect(source).not.toContain("mergePullRequest(");
    expect(source).not.toContain("closePullRequest(");
  });

  it.each(DETAIL_SOURCES)("%s はPRへの修正依頼を送らない", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("sendPrFixNotify");
    expect(source).not.toContain("requestPrFixCommentBody");
    expect(source).not.toContain("<PullRequestReviewFindings");
  });
});

/**
 * PRへの修正依頼の送信はPR詳細（`issue-deck-shell.tsx`の`handlePullRequestFixSessionRequest`）
 * の1系統だけにする（#3333）。
 */
describe("PRへの修正依頼の送信（#2919・#3009）", () => {
  /**
   * **呼び戻すときのCLIを渡し忘れない。** `POST /api/dispatch`は`agent`が無いと既定
   * （Claude Code）へ落とすため、書き忘れるとCodexで進んでいたIssueが黙って別のCLIで立ち上がる。
   */
  it("呼び戻すときに`agent`を引き継ぐ", () => {
    const source = readFileSync(SHELL, "utf8");
    expect(source).toContain("agent: route.agent");
  });
});
