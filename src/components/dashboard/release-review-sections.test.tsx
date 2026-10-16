// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseReviewSections, ReleaseVerificationBrief, describeReviewCoverage } from "@/components/dashboard/release-review-sections";
import type { UseReleaseChangesResult } from "@/hooks/use-release-changes";
import { summarizeReleaseReviewDecisions } from "@/lib/release-review-decision";
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
    suggestions: [],
    review: null,
    affectedPullRequests: [],
    affectedFiles: [],
    reviewedFiles: null,
    totalFiles: null,
    coverage: null,
    progress: null,
    diagnostic: null,
    previousRun: null,
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
    mac: { state: "not_recorded", reason: null, summary: null, evidenceUrl: null, updatedAt: null },
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
    expect(titles).toEqual(["今必要な対応", "全体レビュー", "統合検証", "個別PRレビュー"]);
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

  it("未確認範囲が残る結果から、詳細を開かずに再実行できる。統合検証の結果待ちの間は押せない（#4632）", () => {
    const aiReview = section({
      state: "needs_check",
      reason: "未確認範囲があります: 統合検証の結果待ち",
      updatedAt: "2026-10-13T09:00:00.000Z",
      coverage: { open: [{ file: "src/a.ts", kind: "unconfirmed" }] } as never,
    });
    const view = (integration: ReleaseVerificationSection) =>
      render(
        <ReleaseReviewSections
          repositoryFullName="guchi-apps/issue-deck"
          headRef={HEAD}
          pullRequestNumber={4627}
          verification={summary({ aiReview, integration })}
          verificationError={null}
          changes={loadedChanges([])}
        />,
      );
    const waiting = view(section({ kind: "integration", state: "running" }));
    const waitingButton = within(screen.getByTestId("review-rerun-panel")).getByRole("button") as HTMLButtonElement;
    expect(waitingButton.disabled).toBe(true);
    expect(screen.getByText(/統合検証の完了を待っています/)).toBeTruthy();
    waiting.unmount();

    view(section({ kind: "integration", state: "passed", updatedAt: "2026-10-13T10:51:00.000Z" }));
    const readyButton = within(screen.getByTestId("review-rerun-panel")).getByRole("button") as HTMLButtonElement;
    expect(readyButton.disabled).toBe(false);
    expect(readyButton.textContent).toContain("証跡を更新");
  });

  it("再実行の受付は合格ではないと示し、連打しても1回しか依頼しない（#4632）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, outcome: "queued" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ReleaseReviewSections
        repositoryFullName="guchi-apps/issue-deck"
        headRef={HEAD}
        pullRequestNumber={4627}
        verification={summary({
          aiReview: section({ state: "needs_check", updatedAt: "2026-10-13T09:00:00.000Z" }),
          integration: section({ kind: "integration", state: "passed", updatedAt: "2026-10-13T10:51:00.000Z" }),
        })}
        verificationError={null}
        changes={loadedChanges([])}
      />,
    );
    const button = within(screen.getByTestId("review-rerun-panel")).getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(/これはレビューの合格ではありません/)).toBeTruthy());
    const rerunCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("review-rerun"));
    expect(rerunCalls).toHaveLength(1);
    vi.unstubAllGlobals();
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

  it("再レビューの確認範囲・引き継ぎ・未確認項目・再発と新規・改善提案を既存の区分から読める（#4559）", () => {
    renderSections(
      summary({
        aiReview: section({
          state: "needs_check",
          review: {
            checklistVersion: 1,
            legacy: false,
            mode: "rereview",
            fullReviewReason: null,
            recheckScope: "修正差分6ファイルとその呼び出し元",
            previous: { prNumber: 4500, baseSha: "b".repeat(40), headSha: "4d5e6f7".padEnd(40, "0") },
            fixDiffFileCount: 6,
            addedPullRequests: [],
            checks: [
              { id: "auth_boundary", status: "confirmed", evidence: "認可は前回から変更なし", source: "carried_over", carriedFromHeadSha: "4d5e6f7".padEnd(40, "0") },
              { id: "host_compat", status: "unconfirmed", evidence: "pollerを読めていない", source: "current", carriedFromHeadSha: null },
            ],
            previousFindings: [{ id: "R-3f2a01", title: "旧pollerで受信できない", status: "resolved", evidence: "report/route.tsで確認" }],
          },
          findings: [
            { severity: "high", title: "二重実行", detail: "", impact: null, evidence: null, recommendation: null, file: null, line: null, pullRequests: [], id: "R-b90400", status: "new", discovery: "fix_induced", blockingReason: "同じ候補が2回作り直される" },
          ],
          suggestions: [
            { severity: "low", title: "文言を整えたい", detail: "", impact: null, evidence: null, recommendation: null, file: null, line: null, pullRequests: [] },
          ],
        }),
      }),
    );
    const ai = row("全体レビュー");
    expect(within(ai).getByText("再レビュー")).toBeTruthy();
    expect(within(ai).getByText("確認項目 v1")).toBeTruthy();
    expect(within(ai).getByText(/未確認の項目 1件・未解決の阻害指摘 1件/)).toBeTruthy();
    expect(within(ai).getByText(/前回から引き継ぎ（4d5e6f7の結果）/)).toBeTruthy();
    expect(within(ai).getByText("修正差分6ファイルとその呼び出し元")).toBeTruthy();
    expect(within(ai).getByText(/R-b90400 · 新規・修正由来/)).toBeTruthy();
    expect(within(ai).getByText("止める理由: 同じ候補が2回作り直される")).toBeTruthy();
    expect(within(ai).getByText(/改善提案 1件（リリースは止めません/)).toBeTruthy();
    expect(within(ai).getByText(/再レビューは合格の保証ではありません/)).toBeTruthy();
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

describe("describeReviewCoverage（#4615）", () => {
  const cov = (over: Record<string, number> = {}) => ({
    inputFiles: 113,
    reviewed: 120,
    unreadable: 0,
    unreviewed: 0,
    open: [],
    batches: 2,
    pendingBatches: 0,
    ...over,
  });

  it("確認実績の件数を出し、入力に載せた件数（113）とは混ぜない", () => {
    expect(describeReviewCoverage({ coverage: cov(), reviewedFiles: 120, totalFiles: 120 })).toBe("確認済み 120 / 120 ファイル・2バッチ");
  });

  it("未確認・取得不能・残りバッチを区別して出す", () => {
    const text = describeReviewCoverage({
      coverage: cov({ reviewed: 100, unreviewed: 15, unreadable: 5, pendingBatches: 1 }),
      reviewedFiles: 100,
      totalFiles: 120,
    });
    expect(text).toBe("確認済み 100 / 120 ファイル（未確認 15・取得不能 5）・2バッチ・残り1バッチ");
  });

  it("実績の無い旧結果は件数を出さず実績不明にする", () => {
    expect(describeReviewCoverage({ coverage: null, reviewedFiles: null, totalFiles: 120 })).toContain("実績不明");
  });

  it("AIの指摘とユーザー判断を分けて出し、公開後作業を配布済みとは扱わない（#4657）", () => {
    const base = "3f2a91c".padEnd(40, "0");
    const finding = {
      id: "R-0000aa",
      severity: "high" as const,
      title: "共通workflowの修正がフリートへ未配布",
      detail: "配布が必要",
      impact: "利用repoが旧版のまま",
      evidence: "タグ未公開",
      recommendation: null,
      file: null,
      line: null,
      pullRequests: [],
      blockingReason: "必須の配布の欠落",
    };
    const second = { ...finding, id: "R-0000bb", title: "別の指摘" };
    const decisions = summarizeReleaseReviewDecisions({
      records: [
        {
          id: "d1",
          findingId: "R-0000aa",
          sequence: 1,
          decision: "post_release",
          reason: "配布は本体の公開後にしかできない",
          impact: null,
          scope: null,
          followUp: { repo: "guchi-apps/issue-deck", number: 4651 },
          timing: "本番公開の直後",
          prNumber: 4656,
          headRef: HEAD,
          baseSha: base,
          headSha: "9b07e4d".padEnd(40, "0"),
          severity: "high",
          blocking: true,
          findingTitle: finding.title,
          decidedBy: "m-guchi",
          decidedAt: "2026-10-15T01:00:00.000Z",
        },
      ],
      findings: [finding, second].map((f) => ({ id: f.id, title: f.title, severity: f.severity, blocking: true })),
      suggestions: [],
      current: { baseSha: base },
      state: "needs_check",
      unverifiedScope: null,
    });
    render(
      <ReleaseReviewSections
        repositoryFullName="guchi-apps/issue-deck"
        headRef={HEAD}
        pullRequestNumber={4656}
        verification={summary({ aiReview: section({ state: "needs_check", findings: [finding, second], decisions }) })}
        verificationError={null}
        changes={loadedChanges([])}
      />,
    );
    const ai = row("全体レビュー");
    // AIの原判定はそのまま残る
    expect(within(ai).getAllByText("止める理由: 必須の配布の欠落")).toHaveLength(2);
    expect(within(ai).getByText("ユーザー判断: 公開後に対応する")).toBeTruthy();
    expect(within(ai).getByText(/guchi-apps\/issue-deck#4651/, { selector: "p" })).toBeTruthy();
    expect(within(ai).getAllByText(/未実施/).length).toBeGreaterThan(0);
    expect(within(ai).queryByText(/配布済み(?!とは)/)).toBeNull();
    // 判断していない指摘は未判断として残り、次の操作が案内される
    expect(within(ai).getByText("ユーザー判断: 未判断")).toBeTruthy();
    expect(within(screen.getByTestId("review-decision-summary")).getByText(/未判断の止める指摘が1件あります/)).toBeTruthy();
  });
});
