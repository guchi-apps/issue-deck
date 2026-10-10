// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseReviewSections, ReleaseVerificationBrief } from "@/components/dashboard/release-review-sections";
import type { UseReleaseChangesResult } from "@/hooks/use-release-changes";
import type { ReleaseVerificationProgress } from "@/lib/release-verification-progress";
import type { ReleaseVerificationSection, ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import type { ReleaseChangePullRequest } from "@/types/pull-request";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

const HEAD = "release-main/v8.48.1";

function section(overrides: Partial<ReleaseVerificationSection> = {}): ReleaseVerificationSection {
  return {
    kind: "ai_review",
    state: "not_run",
    reason: null,
    summary: null,
    evidenceUrl: null,
    agent: null,
    updatedAt: null,
    findings: [],
    affectedPullRequests: [],
    affectedFiles: [],
    reviewedFiles: null,
    totalFiles: null,
    progress: null,
    diagnostic: null,
    ...overrides,
  };
}

function summary(overrides: Partial<ReleaseVerificationSummary> = {}): ReleaseVerificationSummary {
  return {
    enforced: false,
    gateStatus: "blocked",
    blockers: [],
    integration: section({ kind: "integration" }),
    aiReview: section(),
    aiReviewAssignee: "Claude Code · opus",
    target: { baseSha: "3f2a91c".padEnd(40, "0"), headSha: "9b07e4d".padEnd(40, "0") },
    ...overrides,
  };
}

function progress(overrides: Partial<ReleaseVerificationProgress> = {}): ReleaseVerificationProgress {
  return {
    jobStatus: "running",
    host: "subpc",
    hostOnline: true,
    requestedAt: new Date(Date.now() - 300_000).toISOString(),
    claimedAt: new Date(Date.now() - 290_000).toISOString(),
    startedAt: new Date(Date.now() - 245_000).toISOString(),
    lastReportAt: new Date(Date.now() - 5_000).toISOString(),
    finishedAt: null,
    message: null,
    steps: ["準備", "統合", "依存関係取得", "テスト", "ビルド"].map((label, i) => ({
      key: (["prepare", "merge", "install", "test", "build"] as const)[i],
      label,
    })),
    currentIndex: 3,
    commandPosition: { index: 2, total: 3 },
    command: "pnpm test",
    files: null,
    agent: null,
    stalledAfterMs: 600_000,
    ...overrides,
  };
}

function pr(number: number, kind: "ok" | "changes-requested" | null, extra: Partial<ReleaseChangePullRequest> = {}) {
  return {
    number,
    title: `PR ${number}`,
    issueNumber: null,
    isVersionBump: false,
    review: kind
      ? {
          reviewKind: kind,
          reviewLabel: "",
          riskKind: "unknown",
          riskLabel: "",
          riskReasons: [],
          confirmLabel: null,
          reviewedSha: null,
        }
      : null,
    prHeadSha: null,
    reviewUnavailable: false,
    ...extra,
  } as ReleaseChangePullRequest;
}

const loadedChanges = (pullRequests: ReleaseChangePullRequest[]): UseReleaseChangesResult => ({
  data: { pullRequests, unknownCommits: [], source: "release-pr", headSha: null, truncated: false } as never,
  isLoading: false,
  error: null,
});

function renderSections(verification: ReleaseVerificationSummary | null, changes = loadedChanges([]), error?: string) {
  return render(
    <ReleaseReviewSections
      repositoryFullName="guchi-apps/issue-deck"
      headRef={HEAD}
      verification={verification}
      verificationError={error ?? null}
      changes={changes}
    />,
  );
}

const row = (title: string) => screen.getByTestId(`release-section-${title}`);

describe("ReleaseReviewSections", () => {
  afterEach(cleanup);

  it("全体レビュー → 統合検証 → 個別PRレビューの順に並べる", () => {
    renderSections(summary());
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["全体レビュー", "統合検証", "個別PRレビュー"]);
  });

  it("未実施を問題なしと出さず、担当予定を出す。表示のみのリポジトリはその旨を出す", () => {
    renderSections(summary());
    expect(within(row("全体レビュー")).getByText("未実施")).toBeTruthy();
    expect(within(row("全体レビュー")).getByText("担当予定: Claude Code · opus")).toBeTruthy();
    expect(within(row("統合検証")).getByText("未実施")).toBeTruthy();
    expect(screen.queryByText("問題なし")).toBeNull();
    expect(screen.getByText(/この検証は表示のみです/)).toBeTruthy();
  });

  it("実行中は現在の工程と経過時間・実行先を閉じたまま出す", () => {
    renderSections(summary({ integration: section({ kind: "integration", state: "running", progress: progress() }) }));
    const integration = row("統合検証");
    expect(within(integration).getByText("実行中")).toBeTruthy();
    expect(within(integration).getByText("テスト（検証コマンド 2/3）")).toBeTruthy();
    expect(within(integration).getByText(/開始から 4分0[45]秒 ・ subpc ・ 最終報告 [56]秒前/)).toBeTruthy();
    expect(within(integration).getByRole("listitem", { current: "step" }).textContent).toBe("テスト");
    // 百分率は出さない
    expect(integration.textContent).not.toMatch(/%/);
  });

  it("報告が途絶えたものは応答なしにし、成功とは扱わない", () => {
    renderSections(
      summary({
        integration: section({
          kind: "integration",
          state: "waiting",
          progress: progress({ lastReportAt: new Date(Date.now() - 12 * 60_000).toISOString() }),
        }),
      }),
    );
    const integration = row("統合検証");
    expect(within(integration).getByText("応答なし")).toBeTruthy();
    expect(within(integration).getByText(/成功とは扱いません/)).toBeTruthy();
    expect(within(integration).getByRole("listitem", { current: "step" }).className).not.toContain("animate-pulse");
  });

  it("待機中は実行先オフラインと待機理由の未取得を区別する", () => {
    renderSections(
      summary({
        integration: section({
          kind: "integration",
          state: "waiting",
          progress: progress({ jobStatus: "queued", hostOnline: false, startedAt: null, claimedAt: null, currentIndex: null }),
        }),
        aiReview: section({ state: "waiting" }),
      }),
    );
    expect(within(row("統合検証")).getByText("実行先 subpc がオフラインです")).toBeTruthy();
    expect(within(row("全体レビュー")).getByText("待機理由: 未取得")).toBeTruthy();
  });

  it("全体レビューの指摘の数と、いちばん重い指摘の題を閉じたまま出す。担当は記録どおり", () => {
    renderSections(
      summary({
        aiReview: section({
          state: "needs_check",
          agent: "codex:gpt-6-sol",
          updatedAt: "2026-10-10T09:42:00.000Z",
          findings: [
            { severity: "low", title: "表記ゆれ", detail: "", file: null, pullRequests: [] },
            { severity: "medium", title: "取消時に進捗が残る", detail: "", file: "jobs.ts", pullRequests: [4271] },
          ] as never,
        }),
      }),
    );
    const ai = row("全体レビュー");
    expect(within(ai).getByText("要確認")).toBeTruthy();
    expect(within(ai).getByText("指摘 2件（重大 0・中 1・軽微 1）")).toBeTruthy();
    expect(within(ai).getByText("担当: Codex · gpt-6-sol")).toBeTruthy();
    expect(within(ai).getByText("中: 取消時に進捗が残る")).toBeTruthy();
  });

  it("実行障害はレビュー未完了として出し、コード不合格・問題なしと区別する（#4300）", () => {
    const target = { baseSha: "3f2a91c".padEnd(40, "0"), headSha: "9b07e4d".padEnd(40, "0") };
    renderSections(
      summary({
        aiReview: section({
          state: "failed",
          reason: "全体レビューを完走できませんでした（終了コード 126）",
          updatedAt: "2026-10-10T09:42:00.000Z",
          diagnostic: {
            stage: "review",
            cause: "launch_failed",
            exitCode: 126,
            excerpt: "claude: Permission denied",
            targetBaseSha: target.baseSha,
            targetHeadSha: target.headSha,
          },
        }),
      }),
    );
    const ai = row("全体レビュー");
    expect(within(ai).getByText("レビュー未完了")).toBeTruthy();
    expect(within(ai).queryByText("失敗")).toBeNull();
    expect(within(ai).queryByText("問題なし")).toBeNull();
    expect(within(ai).getByText("原因: AI CLIを起動できませんでした")).toBeTruthy();
    expect(within(ai).getByText(/AIレビュー$/)).toBeTruthy();
    expect(within(ai).getAllByText(/終了コード 126/).length).toBeGreaterThan(0);
    expect(within(ai).getByText("claude: Permission denied")).toBeTruthy();
    // 直すコードは無いので、作り直しの案内は出さない
    expect(within(ai).queryByText(/developへ入れてから作り直します/)).toBeNull();
  });

  it("診断が無い失敗は原因未特定として出し、権限などを断定しない", () => {
    renderSections(summary({ aiReview: section({ state: "failed", reason: "古い実行側の失敗" }) }));
    const ai = row("全体レビュー");
    expect(within(ai).getByText("レビュー未完了")).toBeTruthy();
    expect(within(ai).getByText(/原因未特定です/)).toBeTruthy();
    expect(within(ai).queryByText(/権限/)).toBeNull();
  });

  it("要修正の指摘は影響・根拠・推奨対応・行を読め、作り直しの案内を維持する", () => {
    renderSections(
      summary({
        aiReview: section({
          state: "needs_check",
          findings: [
            {
              severity: "high",
              title: "退行",
              detail: "概要",
              impact: "本番で保存できない",
              evidence: "a.tsの呼び出しが未更新",
              recommendation: "呼び出し元を更新する",
              file: "a.ts",
              line: 12,
              pullRequests: [3],
            },
          ],
        }),
      }),
    );
    const ai = row("全体レビュー");
    expect(within(ai).getByText("影響: 本番で保存できない")).toBeTruthy();
    expect(within(ai).getByText("推奨対応: 呼び出し元を更新する")).toBeTruthy();
    expect(within(ai).getByText("a.ts:12")).toBeTruthy();
    expect(within(ai).getByText(/developへ入れてから作り直します/)).toBeTruthy();
  });

  it("古い対象の結果は古い結果として出す", () => {
    renderSections(summary({ aiReview: section({ state: "invalidated", reason: "対象が変わりました" }) }));
    expect(within(row("全体レビュー")).getByText("古い結果")).toBeTruthy();
    expect(within(row("全体レビュー")).queryByText("問題なし")).toBeNull();
  });

  it("取得に失敗したら取得できませんと出し、問題なしと扱わない", () => {
    renderSections(null, { data: null, isLoading: false, error: "反映内容を取得できませんでした (502)" }, "検証の状態を取得できませんでした (500)");
    expect(screen.getAllByText("取得できません")).toHaveLength(3);
    expect(screen.queryByText("問題なし")).toBeNull();
  });

  it("個別PRはPR件数と判定の内訳、要修正のPRを閉じたまま出し、開くとPR別の一覧", () => {
    renderSections(
      summary(),
      loadedChanges([
        pr(4271, "ok"),
        pr(4268, "changes-requested"),
        pr(4255, null),
        pr(4253, null, { isVersionBump: true, title: "v8.48.1 バンプ" }),
      ]),
    );
    const individual = row("個別PRレビュー");
    expect(within(individual).getByText("PR 3件")).toBeTruthy();
    expect(within(individual).getByText("（＋バンプ1）")).toBeTruthy();
    expect(within(individual).getByText("要修正 1")).toBeTruthy();
    expect(within(individual).getByText("記録なし 1")).toBeTruthy();
    expect(within(individual).getByText("#4268が要修正")).toBeTruthy();
    expect(within(individual).getByText("PR 4268")).toBeTruthy();
    expect(within(individual).getByText("対象外")).toBeTruthy();
  });

  it("凍結ブランチ以外（旧世代のリリースPR）では何も出さない", () => {
    render(
      <ReleaseReviewSections
        repositoryFullName="guchi-apps/issue-deck"
        headRef="develop"
        verification={summary()}
        changes={loadedChanges([])}
      />,
    );
    expect(screen.queryByTestId("release-review-sections")).toBeNull();
  });
});

describe("ReleaseVerificationBrief（ブランチ画面。#4357）", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stubFetch(verification: ReleaseVerificationSummary) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ verification }), { status: 200 })),
    );
  }

  it("全体レビューと統合検証を名前付きで別々に出し、個別PRレビューは出さない", async () => {
    stubFetch(
      summary({
        aiReview: section({ state: "passed" }),
        integration: section({ kind: "integration", state: "failed", reason: "テストが失敗しました" }),
      }),
    );
    render(
      <ReleaseVerificationBrief repositoryFullName="guchi-apps/issue-deck" pullRequestNumber={4345} headRef={HEAD} />,
    );
    await waitFor(() => expect(within(row("全体レビュー")).getByText("問題なし")).toBeTruthy());
    expect(within(row("統合検証")).getByText("失敗")).toBeTruthy();
    expect(screen.queryByText("個別PRレビュー")).toBeNull();
  });

  it("要修正でも作り直しの案内・ボタンは出さない（追加PR群の直下に1つだけ置くため）", async () => {
    stubFetch(summary({ aiReview: section({ state: "invalidated" }) }));
    render(
      <ReleaseVerificationBrief repositoryFullName="guchi-apps/issue-deck" pullRequestNumber={4345} headRef={HEAD} />,
    );
    await waitFor(() => expect(within(row("全体レビュー")).getByText("古い結果")).toBeTruthy());
    fireEvent.click(within(row("全体レビュー")).getByText("古い結果"));
    expect(screen.queryByText(/developへ入れてから作り直します/)).toBeNull();
    expect(screen.queryByRole("button", { name: /作り直す/ })).toBeNull();
  });

  it("凍結ブランチ以外では何も出さない", () => {
    stubFetch(summary());
    const { container } = render(
      <ReleaseVerificationBrief repositoryFullName="guchi-apps/issue-deck" pullRequestNumber={1} headRef="develop" />,
    );
    expect(container.innerHTML).toBe("");
  });
});
