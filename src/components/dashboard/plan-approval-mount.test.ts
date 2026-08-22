import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 計画の承認パネル（#2061）が**PCとスマホの両方の詳細に出ている**ことを守る。
 *
 * **Issue詳細はPC版（`issue-detail.tsx`）とスマホ版（`mobile/mobile-issue-detail.tsx`）で
 * 別のコンポーネント**になっており、片方へ足しただけでは、もう片方は従来どおり
 * 「承認・修正はRemote Controlから伝えてください」しか出ない（実際にスマホ側が抜けていた）。
 *
 * 描画のテストで両方を確かめるにはそれぞれのモック一式が要るため、**置き忘れだけを**
 * ここで捕まえる。`data-check-user-target`（案内パネルの「計画へ移動」の行き先）も
 * 同じ理由で両方に要る。
 */
const DETAIL_SOURCES = [
  "src/components/dashboard/issue-detail.tsx",
  "src/components/dashboard/mobile/mobile-issue-detail.tsx",
] as const;

describe("計画の承認パネルの置き場所（#2061）", () => {
  it.each(DETAIL_SOURCES)("%s が計画パネルを描く", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("<PlanApprovalPanel");
  });

  it.each(DETAIL_SOURCES)("%s が「計画へ移動」の行き先を持つ", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain('checkUserTargetProps("plan")');
  });

  it.each(DETAIL_SOURCES)("%s が確認待ちの案内へ計画待ちを渡す", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("planDecisionPending");
  });

  /**
   * #2158。**Issueを切り替えても詳細はマウントされたまま**なので、`key`が無いと
   * 前の計画に対して押した結果や書きかけの修正本文が次の計画へ持ち越される
   * （押していない計画に「承認を送りました」が出ていた）。
   */
  it.each(DETAIL_SOURCES)("%s が計画ごとにパネルを作り直す", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("key={planRequest.id}");
  });
});
