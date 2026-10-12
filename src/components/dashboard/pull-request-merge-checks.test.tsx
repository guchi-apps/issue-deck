// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PullRequestMergeChecks } from "@/components/dashboard/pull-request-merge-checks";
import { buildMergeChecks, ciCell } from "@/lib/pull-request-merge-checks";
import { buildReleaseCheckCells } from "@/lib/release-candidate-checks";

const cell = { mark: "●", state: "なし", tone: "ok" as const, reason: null, target: "x", evidence: null };

describe("PullRequestMergeChecks", () => {
  it("6項目を固定の順序で、記号と日本語の状態つきで出す", () => {
    const release = buildReleaseCheckCells({ source: { status: "loaded", candidates: [] }, pullRequestNumber: 1, nowMs: 0 });
    const html = renderToStaticMarkup(
      <PullRequestMergeChecks
        checks={buildMergeChecks({ ci: ciCell("failure"), code: cell, conflict: cell, release })}
        candidate={release.candidate}
        onOpenPullRequest={null}
        onOpenCandidate={null}
      />,
    );
    const order = ["CI", "コード", "競合", "全体〔共通〕", "統合〔共通〕", "Mac〔共通〕"].map((label) => html.indexOf(`>${label}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("失敗");
    expect(html).toContain("リリース未作成");
    expect(html.match(/<button/g)).toHaveLength(6);
    // スマホは3項目ずつの2段、広い画面は1行（横スクロールにしない）
    expect(html).toContain("grid-cols-3 xl:grid-cols-6");
    expect(html).not.toContain("計画");
  });

  it("共通結果には対象の候補PR・SHAを添え、複数の候補があれば選択肢を出す", async () => {
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const make = (number: number) => ({
      number,
      title: "t",
      headRef: `release-main/v1.0.${number}`,
      baseSha: "b".repeat(40),
      headSha: `${number}`.padEnd(40, "a"),
      pullRequestNumbers: [1],
      verification: {
        integration: { kind: "integration", state: "passed", reason: null, progress: null },
        aiReview: { kind: "ai_review", state: "passed", reason: null, progress: null },
        mac: { state: "passed", reason: null },
      } as never,
    });
    const release = buildReleaseCheckCells({
      source: { status: "loaded", candidates: [make(18), make(20)] },
      pullRequestNumber: 1,
      nowMs: 0,
    });
    render(
      <PullRequestMergeChecks
        checks={buildMergeChecks({ ci: ciCell("success"), code: cell, conflict: cell, release })}
        candidate={release.candidate}
        choices={release.choices}
        onSelectCandidate={() => {}}
        onOpenPullRequest={null}
        onOpenCandidate={() => {}}
      />,
    );
    expect(screen.getByText(/共通結果の対象: 候補PR #20/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Mac検証/ }));
    expect(screen.getByRole("combobox").querySelectorAll("option")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /候補PR #20の詳細へ/ })).toBeTruthy();
  });
});
