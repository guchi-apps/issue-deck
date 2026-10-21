// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PullRequestMergeChecks } from "@/components/dashboard/pull-request-merge-checks";
import { buildMergeChecks, ciCell, iosPrecheckCheck } from "@/lib/pull-request-merge-checks";
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
    const order = ["CI", "コード", "競合", "全体〔共通〕", "統合〔共通〕", "iOS〔共通〕"].map((label) => html.indexOf(`>${label}<`));
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
    fireEvent.click(screen.getByRole("button", { name: /^iOS検証/ }));
    expect(screen.getByRole("combobox").querySelectorAll("option")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /候補PR #20の詳細へ/ })).toBeTruthy();
  });

  it("個別PRにiOSを足した4項目は、スマホ幅でも1行に並べ、項目内で改行しない（#4882）", () => {
    const release = buildReleaseCheckCells({ source: { status: "loading" }, pullRequestNumber: 0, nowMs: 0 });
    const own = buildMergeChecks({ ci: ciCell("success"), code: cell, conflict: cell, release }).filter((c) => !c.common);
    const html = renderToStaticMarkup(
      <PullRequestMergeChecks
        ownOnly
        checks={[...own, iosPrecheckCheck(null)]}
        candidate={null}
        onOpenPullRequest={null}
        onOpenCandidate={null}
      />,
    );
    const order = ["CI", "コード", "競合", "iOS"].map((label) => html.indexOf(`>${label}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html).toContain('class="grid grid-cols-4"');
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("text-xs leading-4 sm:text-sm sm:leading-5");
    expect(html).toContain("記録なし");
  });

  it("ブランチ画面の4項目（競合・全体・統合・iOS）は4列1段・狭い幅は10pxで、〔共通〕を省く（#4912）", () => {
    const release = buildReleaseCheckCells({ source: { status: "loaded", candidates: [] }, pullRequestNumber: 1, nowMs: 0 });
    const checks = buildMergeChecks({ ci: ciCell("success"), code: cell, conflict: cell, release }).filter(
      (c) => c.key !== "ci" && c.key !== "code",
    );
    const html = renderToStaticMarkup(
      <PullRequestMergeChecks checks={checks} candidate={release.candidate} onOpenPullRequest={null} onOpenCandidate={null} />,
    );
    expect(checks).toHaveLength(4);
    expect(html).toContain('class="grid grid-cols-4"');
    expect(html).toContain("text-[10px] leading-3 sm:text-sm sm:leading-5");
    expect(html).not.toContain("〔共通〕");
    expect(html).not.toContain("whitespace-nowrap");
  });

  it("iOSを渡さない個別PR（PR一覧）は従来どおり3項目・通常の文字サイズ", () => {
    const release = buildReleaseCheckCells({ source: { status: "loading" }, pullRequestNumber: 0, nowMs: 0 });
    const own = buildMergeChecks({ ci: ciCell("success"), code: cell, conflict: cell, release }).filter((c) => !c.common);
    const html = renderToStaticMarkup(
      <PullRequestMergeChecks ownOnly checks={own} candidate={null} onOpenPullRequest={null} onOpenCandidate={null} />,
    );
    expect(html).toContain('class="grid grid-cols-3"');
    expect(html).not.toContain("whitespace-nowrap");
  });
});
