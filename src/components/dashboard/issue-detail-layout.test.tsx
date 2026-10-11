// @vitest-environment jsdom
import { readFileSync } from "node:fs";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IssueDetailLayout } from "@/components/dashboard/issue-detail-layout";

function renderOrder(promotePullRequests: boolean, withSupplement = true): string[] {
  const { container } = render(
    <div>
      <IssueDetailLayout
        title={<p data-part="title" />}
        status={<p data-part="status" />}
        decision={<p data-part="decision" />}
        supplement={withSupplement ? <p data-part="supplement" /> : undefined}
        overview={<p data-part="overview" />}
        related={<p data-part="related" />}
        pullRequests={<p data-part="pull-requests" />}
        promotePullRequests={promotePullRequests}
        activity={<p data-part="activity" />}
      />
    </div>,
  );
  return [...container.querySelectorAll("[data-part]")].map(
    (node) => node.getAttribute("data-part") ?? "",
  );
}

describe("IssueDetailLayout（#4440）", () => {
  afterEach(() => {
    cleanup();
  });

  it("タイトル→状態と主操作→判断材料→補足→概要→関連→対応PR→活動の順に並べる", () => {
    expect(renderOrder(false)).toEqual([
      "title",
      "status",
      "decision",
      "supplement",
      "overview",
      "related",
      "pull-requests",
      "activity",
    ]);
  });

  it("マージ待ち・PR失敗のときは対応PRを判断材料の直後へ上げる（#1288の意図を保つ）", () => {
    expect(renderOrder(true)).toEqual([
      "title",
      "status",
      "decision",
      "pull-requests",
      "supplement",
      "overview",
      "related",
      "activity",
    ]);
  });

  it("補足が無い画面（PC）でも残りの順は変わらない", () => {
    expect(renderOrder(false, false)).toEqual([
      "title",
      "status",
      "decision",
      "overview",
      "related",
      "pull-requests",
      "activity",
    ]);
  });
});

/**
 * PC・スマホの詳細が、並びを自前で書かずに共通部品へ渡していることを固定する。
 * どちらかだけが直接並べ始めると、#4440以前の「同じ並びを2か所に書く」状態へ戻る。
 */
describe.each([
  "src/components/dashboard/issue-detail.tsx",
  "src/components/dashboard/mobile/mobile-issue-detail.tsx",
])("%s", (path) => {
  const source = readFileSync(path, "utf8");

  it("並びを`IssueDetailLayout`へ渡し、対応PRの昇格条件をマージ待ち・PR失敗にしている", () => {
    expect(source).toContain("<IssueDetailLayout");
    expect(source).toContain("promotePullRequests={mergeApprovalPending || hasFailingPullRequest}");
  });

  it("対応PR・子Issueのセクションを自前で描かない", () => {
    expect(source).not.toContain('id="pull-requests"');
    expect(source).not.toContain('id="sub-issues"');
  });
});
