// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseFixCreate, ReleaseFixInternalReview, ReleaseFixOverviewPanel, ReleaseFixStartButton } from "@/components/dashboard/release-fix-panel";
import { ReleaseFixStartContext } from "@/components/dashboard/release-fix-start-context";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

vi.mock("@/hooks/use-reference-navigation", () => ({
  useReferenceNavigation: () => ({ openIssue: vi.fn(), openPullRequest: vi.fn() }),
}));

const section = (state: string, findings: unknown[] = []) =>
  ({ kind: "x", state, reason: null, summary: null, evidenceUrl: null, agent: null, updatedAt: null, findings, affectedPullRequests: [], affectedFiles: [], reviewedFiles: null, totalFiles: null, progress: null, diagnostic: null }) as never;
const verification = {
  enforced: true,
  gateStatus: "blocked",
  blockers: [],
  integration: section("passed"),
  aiReview: section("needs_check", [{ title: "a", severity: "medium" }, { title: "b", severity: "medium" }]),
  mac: { state: "not_applicable", reason: null, summary: null, evidenceUrl: null, updatedAt: null },
  aiReviewAssignee: "x",
  target: { baseSha: "a".repeat(40), headSha: "b".repeat(40) },
} as unknown as ReleaseVerificationSummary;

const seriesRow = {
  id: "s1", status: "stopped", statusLabel: "修正が止まっています", active: false, stepIndex: 5, sourceKind: "review_finding", causeClass: "code",
  itemTitles: ["指摘A"], releasePrNumber: 4394, originBaseSha: "c".repeat(40), originHeadSha: "d".repeat(40), issueNumber: 4395,
  fixPrNumber: 4397, successorPrNumber: 4400, successorBaseSha: "e".repeat(40), successorHeadSha: "f".repeat(40), generation: 1, parentId: null,
  stopReason: "長い停止理由", rebuildFailed: false, startState: "none", createdAt: "2026-10-11T00:00:00.000Z",
};

function stub(row: Record<string, unknown> = seriesRow) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("fix-series") ? { series: [row] } : { episodes: [{ successor: { number: 4400 }, selectedPrs: [{ number: 2 }], excludedPrs: [3] }] }), { status: 200 }),
    ),
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReleaseFixOverviewPanel", () => {
  it("指摘残存: 先頭に状態・残件・主操作を出し、内部情報は折りたたみに置く。無関係Bは含めない", async () => {
    stub();
    const pr = (n: number) => ({ number: n, title: `PR${n}`, issueNumber: null, isVersionBump: false, review: null, prHeadSha: null, reviewUnavailable: false });
    render(
      <ReleaseFixOverviewPanel
        repositoryFullName="o/r"
        pullRequestNumber={4400}
        verification={verification}
        verificationError={null}
        changes={{ data: { pullRequests: [pr(1), pr(2)], unknownCommits: [], source: "release-pr", headSha: null, truncated: false }, isLoading: false, error: null }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("release-fix-headline").textContent).toBe("修正を反映しましたが、チェックで2件の指摘が残っています"),
    );
    expect(screen.getByTestId("release-fix-primary-action").textContent).toContain("修正Issueを作成");
    await waitFor(() => expect(screen.getByTestId("release-fix-technical")).toBeTruthy());
    const contents = screen.getByTestId("release-contents").textContent ?? "";
    expect(contents).toContain("今回の修正で追加");
    expect(contents).toContain("今回は含めない変更");
    expect(contents).toContain("#3");
    const summary = screen.getByTestId("release-fix-summary").textContent ?? "";
    expect(summary).not.toContain("後継候補");
    expect(summary).not.toMatch(/[0-9a-f]{7}/);
    const tech = screen.getByTestId("release-fix-technical");
    expect(tech.tagName).toBe("DETAILS");
    expect(tech.textContent).toContain("修正を反映したリリース #4400");
    expect(tech.textContent).toContain("長い停止理由");
  });

  const noChanges = { data: null, isLoading: true, error: null };

  it("作り直し中に作り直し前のPRを見ているときは、検証結果を修正前として退避させる", async () => {
    stub({ ...seriesRow, status: "rebuilding", active: true, successorPrNumber: null, stopReason: null });
    const onPrevious = vi.fn();
    // 作り直し前のPRの結果は、対象が修正前のhead（起点）になっている
    const oldTarget = { ...verification, target: { baseSha: "c".repeat(40), headSha: "d".repeat(40) } };
    render(
      <ReleaseFixOverviewPanel repositoryFullName="o/r" pullRequestNumber={4394} verification={oldTarget} verificationError={null}
        changes={noChanges} onPreviousResultsChange={onPrevious} />,
    );
    await waitFor(() => expect(onPrevious).toHaveBeenLastCalledWith(true));
    expect(screen.getByTestId("release-fix-headline").textContent).toBe("修正を反映したリリース候補を準備しています");
  });

  it("新しいリリースPRを見ているときは退避しない（現在の結果）", async () => {
    stub({ ...seriesRow, status: "reverifying", active: true, stopReason: null });
    const onPrevious = vi.fn();
    render(
      <ReleaseFixOverviewPanel repositoryFullName="o/r" pullRequestNumber={4400} verification={verification} verificationError={null}
        changes={noChanges} onPreviousResultsChange={onPrevious} />,
    );
    // 最新SHAの結果は現在の結果。再チェック中の系列でも、失敗を「チェック中・操作不要」に隠さない（#4635）
    await waitFor(() =>
      expect(screen.getByTestId("release-fix-headline").textContent).toBe("修正を反映しましたが、チェックで2件の指摘が残っています"),
    );
    expect(screen.queryByTestId("release-fix-auto")).toBeNull();
    expect(onPrevious).not.toHaveBeenCalledWith(true);
  });

  it("準備に失敗: 原因と再試行を出し、「修正Issueを作成」は出さない", async () => {
    stub({ ...seriesRow, status: "stopped", successorPrNumber: null, rebuildFailed: true, stopReason: "候補の作り直しに失敗しました" });
    render(
      <ReleaseFixOverviewPanel repositoryFullName="o/r" pullRequestNumber={4394} verification={verification} verificationError={null}
        changes={noChanges} />,
    );
    await waitFor(() => expect(screen.getByTestId("release-fix-headline").textContent).toBe("修正を反映したリリースの準備に失敗しました"));
    const summary = screen.getByTestId("release-fix-summary").textContent ?? "";
    expect(summary).toContain("候補の作り直しに失敗しました");
    expect(summary).toContain("再試行");
    expect(summary).not.toContain("修正Issueを作成");
  });

  it("変更の取得失敗は変更なしと表示しない", () => {
    stub();
    render(
      <ReleaseFixOverviewPanel repositoryFullName="o/r" pullRequestNumber={4400} verification={verification} verificationError={null}
        changes={{ data: null, isLoading: false, error: "失敗" }} />,
    );
    expect(screen.getByTestId("release-contents").textContent).toContain("変更なしとは扱いません");
  });
});

describe("ReleaseFixStartButton", () => {
  it("Contextが無ければ何も出さない", () => {
    const { container } = render(<ReleaseFixStartButton repositoryFullName="o/r" seriesId="s1" startState="none" />);
    expect(container.textContent).toBe("");
  });

  it("確認が通れば開始ダイアログへIssueを渡す", async () => {
    const issue = { id: "i1", number: 5 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, issue }), { status: 200 })));
    const open = vi.fn();
    render(
      <ReleaseFixStartContext.Provider value={open}>
        <ReleaseFixStartButton repositoryFullName="o/r" seriesId="s1" startState="none" />
      </ReleaseFixStartContext.Provider>,
    );
    fireEvent.click(screen.getByText("修正を開始"));
    await waitFor(() => expect(open).toHaveBeenCalledWith(issue));
  });

  it("失敗してもIssueは作成済みと伝え、再試行できる", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "確認待ちです" }), { status: 409 })));
    render(
      <ReleaseFixStartContext.Provider value={vi.fn()}>
        <ReleaseFixStartButton repositoryFullName="o/r" seriesId="s1" startState="none" />
      </ReleaseFixStartContext.Provider>,
    );
    fireEvent.click(screen.getByText("修正を開始"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("修正Issueは作成済みです"));
    expect(screen.getByText("もう一度開始")).toBeTruthy();
  });

  it("作成直後はIssueが取り込まれるまで無効で、取り込まれたら押せる（#4956）", async () => {
    const responses = [
      new Response(JSON.stringify({ error: "issue_not_synced" }), { status: 409 }),
      new Response(JSON.stringify({ ok: true, issue: { id: "i1", number: 5 } }), { status: 200 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift() ?? new Response("{}", { status: 200 })));
    render(
      <ReleaseFixStartContext.Provider value={vi.fn()}>
        <ReleaseFixStartButton repositoryFullName="o/r" seriesId="s1" startState="none" waitForIssue />
      </ReleaseFixStartContext.Provider>,
    );
    const waiting = screen.getByText("Issueを取り込み中…").closest("button") as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    await waitFor(() => expect((screen.getByText("修正を開始") as HTMLButtonElement).disabled).toBe(false), { timeout: 4000 });
  });

  it("受付済みなら状態と「進捗を見る」を出す", () => {
    render(
      <ReleaseFixStartContext.Provider value={vi.fn()}>
        <ReleaseFixStartButton repositoryFullName="o/r" seriesId="s1" startState="queued" />
      </ReleaseFixStartContext.Provider>,
    );
    expect(screen.getByText("受付済み・起動待ち")).toBeTruthy();
    expect(screen.getByText("進捗を見る")).toBeTruthy();
  });
});

describe("ReleaseFixInternalReview（#4410）", () => {
  const internal = {
    required: true,
    gate: { complete: false, blocker: "open_findings", message: "未解決の指摘が残っています", targetSha: null },
    rounds: [{ round: 2, reviewVerdict: "findings", reviewTargetSha: "7f3a9c1".padEnd(40, "0"), testState: null, testTargetSha: null, openFindingCount: 1 }],
    findings: [
      { key: "F-001", title: "認可の漏れ", detail: null, status: "resolved", reopenCount: 0, regressionCount: 0, resolution: "確認" },
      { key: "F-002", title: "旧pollerの互換", detail: null, status: "open", reopenCount: 1, regressionCount: 0, resolution: null },
    ],
    limits: { round: 2, activeMinutes: 38, budgetMinutes: 120 },
    pause: null,
    pendingPause: null,
    assignee: { name: null, epoch: 0, leaseActive: false, leaseUntil: null },
    attempts: [],
    stopReason: null,
  };
  it("レビュー・テストの状態、未解決の指摘、上限の消費を1つの修正作業として出す", () => {
    render(<ReleaseFixInternalReview current={{ ...seriesRow, internal, continuedFromParent: false } as never} />);
    const text = screen.getByTestId("release-fix-internal").textContent ?? "";
    expect(text).toContain("独立レビュー: 指摘1件");
    expect(text).toContain("テスト: 未実施");
    expect(text).toContain("F-002");
    expect(text).toContain("独立レビュー 2回");
    expect(text).toContain("稼働 38分 / 予算 120分");
  });
  it("一時停止では原因・次の操作・担当と、原因に合う入力欄つきの再開の主操作を出す（PC・スマホ共通の部品）", () => {
    const paused = {
      ...internal,
      pause: { kind: "budget_reached", message: "実行予算に達したため一時停止しています", nextAction: "実行予算を追加して再開する", resumeNeed: "budget", pausedAt: null, pausedSha: null, autoResumable: false },
      assignee: { name: "agent-a", epoch: 2, leaseActive: false, leaseUntil: null },
      stopReason: "実行予算に達したため一時停止しています",
    };
    render(<ReleaseFixInternalReview current={{ ...seriesRow, internal: paused, continuedFromParent: false } as never} repositoryFullName="o/r" />);
    const text = screen.getByTestId("release-fix-internal").textContent ?? "";
    expect(text).toContain("一時停止");
    expect(text).toContain("次の操作: 実行予算を追加して再開する");
    expect(text).toContain("担当: agent-a（応答なし）");
    expect(screen.getByTestId("release-fix-internal-resume").textContent).toBe("予算を追加して再開");
    expect(screen.getByTestId("release-fix-internal-handover")).toBeTruthy();
  });
  it("実行環境の障害は入力欄を出さず、そのまま再開できる", () => {
    const env = { ...internal, pause: { kind: "environment", message: "障害", nextAction: "再開する", resumeNeed: "none", pausedAt: null, pausedSha: null, autoResumable: true }, stopReason: "障害" };
    render(<ReleaseFixInternalReview current={{ ...seriesRow, internal: env, continuedFromParent: false } as never} repositoryFullName="o/r" />);
    expect(screen.getByTestId("release-fix-internal-resume").textContent).toBe("再開する");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("内部確認を求めない系列には何も出さない", () => {
    const { container } = render(<ReleaseFixInternalReview current={{ ...seriesRow, internal: null, continuedFromParent: false } as never} />);
    expect(container.textContent).toBe("");
  });
});

describe("ReleaseFixCreate: 改善提案から起案（#5102）", () => {
  const sha = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
  const suggestion = (id: string, title: string) => ({ id, title, severity: "low" }) as never;

  it("指摘0件・提案1件（今回直す）でも起案でき、提案の添字（指摘件数以降）を送る", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ outcome: "created", series: seriesRow }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ReleaseFixCreate
        repositoryFullName="o/r"
        pullRequestNumber={719}
        target={sha}
        sourceKind="review_finding"
        findings={[suggestion("R-1", "バックアップ設定が未確認")]}
        excludedFindingIds={[]}
        suggestionsFrom={0}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /修正Issueを作成/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toMatchObject({ sourceKind: "review_finding", findingIndexes: [0] });
  });

  it("「今回直す」でない提案は一覧に出さず、既定でも選ばない", () => {
    render(
      <ReleaseFixCreate
        repositoryFullName="o/r"
        pullRequestNumber={719}
        target={sha}
        sourceKind="review_finding"
        findings={[suggestion("R-1", "直す提案"), suggestion("R-2", "判断前の提案")]}
        excludedFindingIds={["R-2"]}
        suggestionsFrom={0}
      />,
    );
    expect(screen.getByText(/直す提案/)).toBeTruthy();
    expect(screen.queryByText(/判断前の提案/)).toBeNull();
    expect(screen.getAllByRole("checkbox")[0]).toHaveProperty("checked", true);
  });
});
