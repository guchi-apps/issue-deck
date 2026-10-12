// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PullRequestDetail } from "@/components/dashboard/pull-request-detail";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type {
  PullRequestDeployStatus,
  PullRequestSummary,
  PullRequestDetail as PullRequestDetailData,
  PullRequestEvent,
} from "@/types/pull-request";

vi.mock("@/components/dashboard/pull-request-ai-review-jobs", () => ({ PullRequestAiReviewJobs: () => null }));
// 本番PR詳細の上部（#4428）は取得を伴うので、ここでは置き場所と並びだけを見る
vi.mock("@/components/dashboard/release-pull-request-overview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/dashboard/release-pull-request-overview")>()),
  ReleasePullRequestOverview: () => <div data-testid="release-overview-stub" />,
}));

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/issue-deck#42",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 42,
    title: "PRの内容を確認できるようにする",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/42",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-1087",
    headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    kind: "issue",
    linkedIssueNumber: 1087,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
    reviewVerdict: null,
    releaseVerification: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return {
    id: "comment-1",
    kind: "comment",
    authorLogin: "claude",
    body: "実装が完了しました。",
    createdAt: "2026-08-01T01:00:00Z",
    reviewState: null,
    path: null,
    line: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<PullRequestDetailData> = {}): PullRequestDetailData {
  return {
    id: "guchi-apps/issue-deck#42",
    summary: makePullRequest(),
    body: "## 実装内容\n\nPR詳細ペインを追加した。",
    additions: 120,
    deletions: 8,
    changedFiles: 5,
    commits: 2,
    events: [makeEvent()],
    fetchedAt: "2026-08-01T02:00:00.000Z",
    ...overrides,
  };
}

function renderDetail(
  overrides: Partial<{
    pullRequest: PullRequestSummary | null;
    detail: PullRequestDetailData | null;
    isLoading: boolean;
    error: string | null;
  }> = {},
) {
  return render(
    <PullRequestDetail
      pullRequest={
        overrides.pullRequest === undefined ? makePullRequest() : overrides.pullRequest
      }
      detail={overrides.detail === undefined ? makeDetail() : overrides.detail}
      isLoading={overrides.isLoading ?? false}
      error={overrides.error ?? null}
      onRefresh={vi.fn()}
      onMerged={vi.fn()}
    />,
  );
}

/** 詳細のタブ（#4427）を開く */
function openTab(name: "概要" | "指摘" | "変更ファイル" | "活動") {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(name) }));
}

/** 本番デプロイ状況の取得（#1814）。既定では「判定できない」を返し、バッジを出さない */
function mockDeployStatus(status: PullRequestDeployStatus | null = null) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ status, fetchedAt: "2026-08-16T12:00:00.000Z" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PullRequestDetail", () => {
  beforeEach(() => {
    mockDeployStatus();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("未選択のときは選択を促す", () => {
    renderDetail({ pullRequest: null, detail: null });
    expect(screen.getByText("PRを選ぶと本文とコメントを表示します。")).toBeTruthy();
  });

  it("本文・差分統計・コメントを表示する", () => {
    renderDetail();
    expect(screen.getByText("実装内容")).toBeTruthy();
    expect(screen.getByText("PR詳細ペインを追加した。")).toBeTruthy();
    // 増減は補足の統計に出る。「変更ファイル」タブを開くと、その見出し（#1987）にも出る。
    expect(screen.getAllByText("+120")).toHaveLength(1);
    expect(screen.getAllByText("-8")).toHaveLength(1);
    expect(screen.getByText(/5ファイル ・ 2コミット/)).toBeTruthy();
    openTab("変更ファイル");
    expect(screen.getAllByText("+120")).toHaveLength(2);
    expect(screen.getAllByText("変更ファイル").length).toBeGreaterThan(1);
    openTab("活動");
    expect(screen.getByText("コメント 1件")).toBeTruthy();
    expect(screen.getByText("実装が完了しました。")).toBeTruthy();
  });

  it("本文が空のPRはその旨を出す", () => {
    renderDetail({ detail: makeDetail({ body: "", events: [] }) });
    expect(screen.getByText("本文はありません。")).toBeTruthy();
    openTab("活動");
    expect(screen.getByText("コメントはまだありません。")).toBeTruthy();
  });

  it("レビューは結果、レビューコメントは対象ファイルと行を出す", () => {
    renderDetail({
      detail: makeDetail({
        events: [
          makeEvent({ id: "review-1", kind: "review", reviewState: "changes_requested", body: "修正してください。" }),
          makeEvent({
            id: "review-comment-1",
            kind: "review-comment",
            path: "src/lib/foo.ts",
            line: 12,
            body: "この分岐は不要です。",
          }),
        ],
      }),
    });

    openTab("活動");
    expect(screen.getByText("変更を要求")).toBeTruthy();
    expect(screen.getByText("src/lib/foo.ts:12")).toBeTruthy();
  });

  // `mergeable`は詳細ではなくsummaryが持つ（一覧・詳細で同じ判定にするため。#1742）
  it("コンフリクトしているPRは警告と統合した自動修正ボタンを出し、マージボタンを出さない", () => {
    renderDetail({ pullRequest: makePullRequest({ mergeable: false }) });
    expect(screen.getByTestId("pull-request-primary-action").textContent).toContain("競合あり");
    expect(screen.getByRole("button", { name: "PRを自動修正" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  // 一覧から主操作を詳細へ集約した（#4427）。一覧にあった修復ボタンの条件はここで確かめる。
  it("マージできるPRには主操作の帯にマージボタンを出し、状態と理由を添える（#4427）", () => {
    renderDetail({ pullRequest: makePullRequest({ ciState: "success", mergeable: true }) });
    const band = within(screen.getByTestId("pull-request-primary-action"));
    expect(band.getByText(/マージ可能/)).toBeTruthy();
    expect(band.getByRole("button", { name: "マージする" })).toBeTruthy();
  });

  it("CI失敗のPRには自動修正ボタンを出し、確認ダイアログを挟む（#1293）", () => {
    renderDetail({ pullRequest: makePullRequest({ ciState: "failure" }) });
    expect(screen.getByRole("button", { name: "PRを自動修正" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "マージする" }));
    expect(screen.getByText("このPRをマージしますか？")).toBeTruthy();
    expect(screen.getByText("CIが失敗しています。")).toBeTruthy();
  });

  it("自動修復ワークフローが未配布なら修復ボタンを押せなくして理由を添える（#1960）", () => {
    renderDetail({
      pullRequest: makePullRequest({
        ciState: "failure",
        mergeable: false,
        repairWorkflowAvailability: { ci: "missing", conflict: "missing" },
      }),
    });
    expect(screen.getByRole("button", { name: "PRを自動修正" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("自動修復ワークフローが未配布です。設定 › フリート運用 から、このリポジトリへ配布できます。"),
    ).toBeTruthy();
    cleanup();

    renderDetail({ pullRequest: makePullRequest({ ciState: "failure", repairWorkflowAvailability: {} }) });
    expect(screen.getByRole("button", { name: "PRを自動修正" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/未配布/)).toBeNull();
  });

  it("自動修正が走っているあいだは「修正中」と経過を出し、ボタンを押せなくする（#2072・#4427）", () => {
    renderDetail({
      pullRequest: makePullRequest({
        ciState: "failure",
        repairRun: {
          kind: "ci",
          startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
          runUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
        },
      }),
    });
    const band = within(screen.getByTestId("pull-request-primary-action"));
    expect(band.getByText(/修正中/, { selector: "p" })).toBeTruthy();
    expect(band.getByText("PRを自動修正中（3分経過）")).toBeTruthy();
    expect(band.getByRole("button", { name: "PRを自動修正" }).hasAttribute("disabled")).toBe(true);
  });

  it("自動マージ可否の判定中は「判定中」で押せなくする（#1968）", () => {
    renderDetail({
      pullRequest: makePullRequest({
        ciState: "success",
        mergeJudgement: { state: "pending", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
      }),
    });
    const button = screen.getByRole("button", { name: "判定中" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  it("リリース候補が未作成でも通常PRのマージ判定は変わらず、共通説明を1回だけ出す（#4427）", () => {
    renderDetail({ pullRequest: makePullRequest({ ciState: "success", mergeable: true }) });
    expect(screen.getByRole("button", { name: "マージする" })).toBeTruthy();
    expect(screen.getByLabelText("このPRのチェック")).toBeTruthy();
    expect(screen.getByLabelText("リリース候補のチェック")).toBeTruthy();
    expect(screen.queryAllByTestId("release-candidate-note").length).toBeLessThanOrEqual(1);
  });

  it("自動でマージされないPRには「ユーザーのマージが必要です」を出す（#1469）", () => {
    renderDetail({ pullRequest: makePullRequest({ linkedIssueCheckUser: true }) });
    expect(screen.getByText("ユーザーのマージが必要です")).toBeTruthy();
    cleanup();

    renderDetail();
    expect(screen.queryByText("ユーザーのマージが必要です")).toBeNull();
  });

  it("ユーザーのマージが必要なPRには、その理由をバッジの下に出す（#4088）", () => {
    renderDetail({
      pullRequest: makePullRequest({ linkedIssueCheckUser: true }),
      detail: makeDetail({
        userMergeReasons: {
          source: "review",
          items: ["認証・認可に関わる変更が含まれているため"],
          postedAtLabel: "1時間前",
        },
      }),
    });
    expect(screen.getByText("認証・認可に関わる変更が含まれているため")).toBeTruthy();
    cleanup();

    renderDetail({
      pullRequest: makePullRequest(),
      detail: makeDetail({ userMergeReasons: null }),
    });
    expect(screen.queryByText("自動マージされなかった理由")).toBeNull();
  });

  it("CI・レビューの状態を四角い操作表示で出す（#3319）", () => {
    renderDetail({
      pullRequest: makePullRequest({
        mergeJudgement: {
          state: "settled",
          step: null,
          runUrl: null,
          aiReview: { state: "passed", runUrl: null },
        },
      }),
    });
    openTab("指摘");
    expect(screen.getByRole("button", { name: /CI通過/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /レビュー完了/ })).toBeTruthy();
  });

  // #3373: ジョブが成功していても、PR本文の検証結果が要確認・要修正なら、四角枠の文言も
  // それぞれ「レビュー要確認」「レビュー要修正」に変わる（「レビュー完了」固定ではない）
  it("検証結果が要確認・要修正のPRは、四角枠にその判定を出す", () => {
    renderDetail({
      pullRequest: makePullRequest({
        mergeJudgement: {
          state: "settled",
          step: null,
          runUrl: null,
          aiReview: { state: "passed", runUrl: null },
        },
        reviewVerdict: {
          reviewKind: "needs-check",
          reviewLabel: "",
          riskKind: "none",
          riskLabel: "",
          riskReasons: [],
          confirmLabel: null,
          reviewedSha: null,
        },
      }),
    });
    openTab("指摘");
    expect(screen.getByRole("button", { name: /レビュー要確認/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /レビュー完了/ })).toBeNull();
    cleanup();

    renderDetail({
      pullRequest: makePullRequest({
        mergeJudgement: {
          state: "settled",
          step: null,
          runUrl: null,
          aiReview: { state: "passed", runUrl: null },
        },
        reviewVerdict: {
          reviewKind: "changes-requested",
          reviewLabel: "",
          riskKind: "none",
          riskLabel: "",
          riskReasons: [],
          confirmLabel: null,
          reviewedSha: null,
        },
      }),
    });
    openTab("指摘");
    expect(screen.getByRole("button", { name: /レビュー要修正/ })).toBeTruthy();
  });

  it("CI失敗とレビュー要修正が同時でも、修復入口は1つだけで、マージ操作は主要CTAにしない", () => {
    renderDetail({
      pullRequest: makePullRequest({
        ciState: "failure",
        mergeable: true,
        reviewVerdict: {
          reviewKind: "changes-requested",
          reviewLabel: "要修正",
          riskKind: "none",
          riskLabel: "該当なし",
          riskReasons: [],
          confirmLabel: null,
          reviewedSha: null,
        },
      }),
    });

    expect(screen.getAllByRole("button", { name: "PRを自動修正" })).toHaveLength(1);
    // 手動マージの経路は残すが、修正対象がある間は補助（outline）として出す
    const mergeButton = screen.getByRole("button", { name: "マージする" });
    expect(mergeButton.getAttribute("data-variant")).toBe("outline");
  });

  // 差分が小さくレビューが走らなかったことを言い切る。何も出さないと未完了と区別が付かない。
  it("レビューが実行されなかったPRは「省略」と出す（#2150）", () => {
    renderDetail({
      pullRequest: makePullRequest({
        mergeJudgement: {
          state: "settled",
          step: null,
          runUrl: null,
          aiReview: { state: "skipped", runUrl: null },
        },
      }),
    });
    openTab("指摘");
    expect(screen.getByText("レビュー省略")).toBeTruthy();
  });

  it("レビュー実行中は丸い判定バッジを重ねず、操作表示だけを出す（#3319）", () => {
    renderDetail({
      pullRequest: makePullRequest({
        mergeJudgement: {
          state: "pending",
          step: "claude-review",
          runUrl: null,
          aiReview: { state: "pending", runUrl: null },
        },
      }),
    });

    openTab("指摘");
    expect(screen.getAllByText("レビュー実施中")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /レビュー実施中/ })).toBeTruthy();
  });

  it("レビューのcheck-runが無いPRにはバッジを出さない（#2150）", () => {
    renderDetail();
    expect(screen.queryByText(/^Claudeのレビュー/)).toBeNull();
  });

  it("CIの操作表示を押すと既存のジョブ内訳を開閉できる（#3319）", () => {
    renderDetail({
      pullRequest: makePullRequest({
        ciState: "pending",
        ciChecks: [
          {
            name: "Unit tests",
            status: "in_progress",
            conclusion: null,
            startedAt: "2026-08-01T01:00:00Z",
            completedAt: null,
            htmlUrl: null,
            runId: null,
          },
        ],
      }),
    });

    openTab("指摘");
    const status = screen.getByRole("button", { name: /CI実行中/ });
    expect(status.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(status);
    expect(status.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("CIの内訳")).toBeTruthy();
    expect(screen.getByText("Unit tests")).toBeTruthy();
  });

  it("再取得でCIのチェック内訳が空になっても、CIの操作表示を維持する（#3325）", () => {
    const initialPullRequest = makePullRequest({
      ciChecks: [
        {
          name: "Unit tests",
          status: "completed",
          conclusion: "success",
          startedAt: "2026-08-01T01:00:00Z",
          completedAt: "2026-08-01T01:01:00Z",
          htmlUrl: null,
          runId: null,
        },
      ],
    });
    const { rerender } = render(
      <PullRequestDetail
        pullRequest={initialPullRequest}
        detail={makeDetail()}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
        onMerged={vi.fn()}
      />,
    );
    openTab("指摘");
    const status = screen.getByRole("button", { name: /CI通過/ });
    expect(status.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(status);
    expect(status.getAttribute("aria-expanded")).toBe("true");

    rerender(
      <PullRequestDetail
        pullRequest={makePullRequest({ ciChecks: [], ciRunId: null })}
        detail={makeDetail()}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
        onMerged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /CI通過/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("レビューの操作表示を押すと判定と本文を開ける（#3319）", () => {
    const headSha = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
    renderDetail({
      pullRequest: makePullRequest({
        mergeJudgement: {
          state: "settled",
          step: null,
          runUrl: null,
          aiReview: { state: "failed", runUrl: null },
        },
      }),
      detail: makeDetail({
        events: [
          makeEvent({
            body: `## 総評\n\n修正が必要です。\n\n<!-- issue-deck-review-verdict:changes-requested sha=${headSha} -->`,
          }),
        ],
      }),
    });

    openTab("指摘");
    const status = screen.getByRole("button", { name: /レビュー失敗/ });
    fireEvent.click(status);
    expect(status.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("要修正")).toBeTruthy();
    // 指摘タブのレビュー本文だけが出る（コメントは「活動」タブ側）
    expect(screen.getAllByText("修正が必要です。")).toHaveLength(1);
  });

  it("別のPRの取得結果は表示しない", () => {
    renderDetail({ detail: makeDetail({ id: "guchi-apps/issue-deck#41" }) });
    expect(screen.queryByText("PR詳細ペインを追加した。")).toBeNull();
  });

  it("draft以外にはマージボタンを出し、draftには出さない", () => {
    renderDetail();
    expect(screen.getByRole("button", { name: "マージする" })).toBeTruthy();
    cleanup();

    renderDetail({ pullRequest: makePullRequest({ draft: true }) });
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
    // ドラフトの主操作は「レビュー可能にする」（#4453）。通常のPRには出さない
    expect(screen.getByRole("button", { name: "レビュー可能にする" })).toBeTruthy();
    cleanup();
    renderDetail();
    expect(screen.queryByRole("button", { name: "レビュー可能にする" })).toBeNull();
  });

  it("取得に失敗したときはエラーを表示する", () => {
    renderDetail({ detail: null, error: "リクエストに失敗しました (502)" });
    expect(screen.getByText("リクエストに失敗しました (502)")).toBeTruthy();
  });

  // 画面内のリンクからは一覧に載っていないPR（マージ済み・クローズ済み）も開ける（#1260）
  it("マージ済みPRはその旨を出し、マージボタンを出さない", () => {
    renderDetail({
      pullRequest: makePullRequest({ state: "closed", merged: true }),
    });
    expect(screen.getByText("マージ済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  it("マージされずクローズされたPRはその旨を出し、マージボタンを出さない", () => {
    renderDetail({
      pullRequest: makePullRequest({ state: "closed", merged: false }),
    });
    expect(screen.getByText("クローズ済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  // 本番へ届いたかをPR詳細で分かるようにする（#1814）
  it("マージ済みPRには本番デプロイ状況のバッジを出し、実行ログへリンクする", async () => {
    mockDeployStatus({
      kind: "deployed",
      version: "4.1.0",
      releasePullRequestNumber: 100,
      deployRunUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    });
    renderDetail({ pullRequest: makePullRequest({ state: "closed", merged: true }) });

    const badge = await screen.findByText("本番反映済み v4.1.0");
    expect(badge.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    );
  });

  // 失敗が見えている場所からそのまま出し直せるようにする（#2236）
  it("デプロイが失敗しているときは、出し直しの帯を出す", async () => {
    mockDeployStatus(
      {
        kind: "failed",
        version: "4.1.0",
        releasePullRequestNumber: 100,
        deployRunUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
      },
    );
    renderDetail({ pullRequest: makePullRequest({ state: "closed", merged: true }) });

    expect(await screen.findByText("このPRの変更は本番へ出ていません")).toBeTruthy();
    expect(screen.getByRole("button", { name: /本番へ再デプロイ/ })).toBeTruthy();
  });

  it("デプロイが成功しているときは出し直しの帯を出さない", async () => {
    mockDeployStatus({
      kind: "deployed",
      version: "4.1.0",
      releasePullRequestNumber: 100,
      deployRunUrl: null,
    });
    renderDetail({ pullRequest: makePullRequest({ state: "closed", merged: true }) });

    await screen.findByText("本番反映済み v4.1.0");
    expect(screen.queryByText("このPRの変更は本番へ出ていません")).toBeNull();
  });

  it("判定できないときはバッジを出さない（未反映と言い切らない）", async () => {
    const fetchMock = mockDeployStatus(null);
    renderDetail({ pullRequest: makePullRequest({ state: "closed", merged: true }) });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/本番/)).toBeNull();
    expect(screen.queryByText(/デプロイ/)).toBeNull();
  });

  it("未マージのPRではデプロイ状況を取りに行かない", async () => {
    const fetchMock = mockDeployStatus({
      kind: "deployed",
      version: "4.1.0",
      releasePullRequestNumber: 100,
      deployRunUrl: null,
    });
    renderDetail();

    await waitFor(() => expect(screen.getByRole("tab", { name: /活動/ })).toBeTruthy());
    const requestedUrls = (fetchMock.mock.calls as unknown as unknown[][]).map((call) =>
      String(call[0]),
    );
    expect(requestedUrls.some((url) => url.includes("/api/pull-requests/deploy-status"))).toBe(
      false,
    );
    expect(screen.queryByText("本番反映済み v4.1.0")).toBeNull();
  });

  it("summaryが未取得のうちは読み込み中として見せる（PRを選ぶ促しは出さない）", () => {
    renderDetail({ pullRequest: null, detail: null, isLoading: true });
    expect(screen.getByText("読み込み中...")).toBeTruthy();
    expect(screen.queryByText("PRを選ぶと本文とコメントを表示します。")).toBeNull();
  });

  it("summaryを取得できなかった場合はエラーを表示する", () => {
    renderDetail({
      pullRequest: null,
      detail: null,
      error: "このPull Requestは見つかりませんでした",
    });
    expect(screen.getByText("Pull Requestを開けませんでした")).toBeTruthy();
    expect(screen.getByText("このPull Requestは見つかりませんでした")).toBeTruthy();
  });

  describe("本番PR詳細（#4428）", () => {
    const release = () =>
      makePullRequest({
        kind: "release",
        baseRef: "main",
        headRef: "release-main/v8.54.0",
        title: "v8.54.0をmainへリリースする",
      });

    it("開いている本番PRは短いヘッダーにし、状態・検証を詳細・履歴より先に出す", () => {
      renderDetail({ pullRequest: release() });
      expect(screen.getByText(/本番PR/)).toBeTruthy();
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("v8.54.0をmainへリリースする");
      const overview = screen.getByTestId("release-overview-stub");
      const history = screen.getByText("詳細・履歴");
      expect(overview.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // 主操作は上部が持つので、バッジの行にはマージボタンを重ねない
      expect(screen.queryByText("マージする")).toBeNull();
    });

    it("マージ済みの本番PRと通常PRは従来の詳細のまま", () => {
      renderDetail({ pullRequest: makePullRequest({ ...release(), merged: true, state: "closed" }) });
      expect(screen.queryByTestId("release-overview-stub")).toBeNull();
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("v8.54.0をmainへリリースする");
      cleanup();
      renderDetail();
      expect(screen.queryByTestId("release-overview-stub")).toBeNull();
      expect(screen.queryByText("詳細・履歴")).toBeNull();
    });
  });

  // #2448。本文は`reusable-release-develop-to-main.yml`が書く形をそのまま写している
  describe("コードレビューの検証結果（#2448）", () => {
    const RELEASE_BODY = `developの内容をv4.49.0としてmainへリリースします。

## 対象issue
- #2441 レビューのゲートを直す
- #2438 更新履歴の文言を短くする

## コードレビューの検証結果

| Issue | PR | 自動レビュー | 機械的リスク判定 |
| --- | --- | --- | --- |
| #2441 | #2446 | ✅ 問題なし | 該当なし |
| #2438 | #2450 | — 実施なし | 該当なし |
| #2432 | — | ? 記録なし | ? 記録なし |

## 注意点
- このPRはGitHub Actionsが自動作成しました
`;

    // #2488。ワークフローが表の下へ足すレビュー本文の折りたたみ
    const DETAIL_SECTION = `<details>
<summary>#2441 の自動レビュー（✅ 問題なし）</summary>

<!-- issue-deck-review-detail:start issue=2441 -->

LGTM。ゲートの条件は仕様どおりです。

[元のレビューコメントを開く](https://github.com/guchi-apps/issue-deck/pull/2446#issuecomment-1)
<!-- issue-deck-review-detail:end -->

</details>

`;

    // 同じ表は本文にもそのまま出る（Markdownとして描かれる）ので、パネルの中だけを見る
    function panel() {
      return within(screen.getByTestId("verification-summary"));
    }

    it("リリースPRでは内訳と行を出す", () => {
      renderDetail({ detail: makeDetail({ body: RELEASE_BODY }) });

      const text = screen.getByTestId("verification-summary").textContent ?? "";

      // 内訳（先に読めること）と、行ごとの判定の両方が出る
      expect(text).toContain("3 件のIssue");
      expect(text).toContain("1問題なし");
      expect(text).toContain("1レビューなし");
      expect(text).toContain("実施なし");
      // 記録が無い行も残す（検証されていないことが読めなくなるため）
      expect(text).toContain("記録なし");
      // 対象issue一覧からタイトルを添える
      expect(panel().getByText("レビューのゲートを直す")).toBeTruthy();
    });

    it("Issue・PRへのリンクを張る（PRが見つからなかった行はリンクにしない）", () => {
      renderDetail({ detail: makeDetail({ body: RELEASE_BODY }) });

      expect(panel().getByRole("link", { name: "#2441" }).getAttribute("href")).toBe(
        "https://github.com/guchi-apps/issue-deck/issues/2441",
      );
      expect(panel().getByRole("link", { name: "PR #2446" }).getAttribute("href")).toBe(
        "https://github.com/guchi-apps/issue-deck/pull/2446",
      );
      expect(panel().queryByRole("link", { name: "PR —" })).toBeNull();
      expect(panel().getByText("PR —")).toBeTruthy();
    });

    it("検証結果を持たないPRではパネルを出さない", () => {
      renderDetail();
      expect(screen.queryByTestId("verification-summary")).toBeNull();
    });

    // #2488。判定だけでは何を指摘されたのかが読めず、develop向けPRのコメントを1件ずつ
    // 開くことになっていた
    it("レビュー本文が載っている行は、開くと本文を読める", () => {
      const body = `${RELEASE_BODY.replace("## 注意点", DETAIL_SECTION + "## 注意点")}`;
      renderDetail({ detail: makeDetail({ body }) });

      // 既定は閉じたまま（10件以上のリリースで帯が本文と同じ長さになるため）
      expect(panel().queryByText(/ゲートの条件は仕様どおりです/)).toBeNull();

      fireEvent.click(panel().getByRole("button", { name: /レビュー内容/ }));

      expect(panel().getByText(/ゲートの条件は仕様どおりです/)).toBeTruthy();
      expect(panel().getByRole("link", { name: "元のレビューコメントを開く" })).toBeTruthy();
    });

    it("レビュー本文が無い行には開くボタンを出さない", () => {
      renderDetail({ detail: makeDetail({ body: RELEASE_BODY }) });

      expect(panel().queryByRole("button", { name: /レビュー内容/ })).toBeNull();
    });
  });
});
