// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionUsagePanel } from "@/components/dashboard/session-usage-panel";
import type { SessionUsagePlanState, SessionUsageResponse } from "@/hooks/use-session-usage";
import { formatDateTime } from "@/lib/format-date-time";
import { buildSessionUsageSummary, type SessionUsageEntry } from "@/lib/session-usage-view";

/**
 * 「AI使用量」画面（#2504）の描画。
 *
 * **確かめたいのは2つ。** (1) セッションごとの行が初期状態から出ること、共通スケールの比率が
 * 表示されること。(2) 金額が常にドルで出ること（#2666で枠%への切り替えは廃止した）。
 */

/** 2026-08-30 12:00 JST */
const NOW_MS = Date.parse("2026-08-30T03:00:00.000Z");

function entry(overrides: Partial<SessionUsageEntry> = {}): SessionUsageEntry {
  return {
    agent: "claude",
    sessionId: "s1",
    host: "subpc",
    kind: "implementation",
    repository: "issue-deck",
    issueNumber: 2504,
    prNumber: null,
    responses: 100,
    inputTokens: 1_000,
    cacheCreateTokens: 2_000,
    cacheReadTokens: 7_000,
    outputTokens: 500,
    contextTokens: 10_000,
    costUsd: 20,
    models: ["claude-opus-5"],
    startedAt: "2026-08-30T01:00:00.000Z",
    endedAt: "2026-08-30T02:00:00.000Z",
    ...overrides,
  };
}

function response(entries: SessionUsageEntry[]): SessionUsageResponse {
  return {
    ...buildSessionUsageSummary({
      entries,
      nowMs: NOW_MS,
      days: 7,
      reportedAt: "2026-08-30T02:55:00.000Z",
    }),
    quotaEstimate: null,
  };
}

/** プラン枠は集計と別に届く（#3304）。既定は「取得済みで、どちらも未設定」 */
const PLAN_LOADED: SessionUsagePlanState = {
  data: {
    planUsage: { claude: null, codex: null },
    planNotConfigured: { claude: true, codex: true },
    quotaEstimate: null,
  },
  error: null,
};

function renderPanel(data: SessionUsageResponse | null, props: Record<string, unknown> = {}) {
  return render(
    <SessionUsagePanel
      data={data}
      plan={PLAN_LOADED}
      isLoading={false}
      error={null}
      days={7}
      onChangeDays={() => {}}
      onRefresh={() => {}}
      {...props}
    />,
  );
}

afterEach(() => cleanup());

describe("SessionUsagePanel", () => {
  const liveSession = {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-3084",
    repository: "issue-deck",
    issueNumber: 3084,
    prNumber: null,
    title: "AI使用量表示に現在のセッション使用状況を追加",
    agent: "claude" as const,
    statusLabel: "入力を待っています",
    statusTone: "waiting" as const,
    startedAt: "2026-08-30T02:00:00.000Z",
    models: ["claude-opus-5"],
    reported: true,
    responses: 141,
    contextTokens: 12_400_000,
    outputTokens: 1_000,
    costUsd: 7.35,
    quotaPercent: 11.23,
  };

  it("実行中のセッションを画面のいちばん上に、金額・5時間枠の割合（小数点1位）付きで出す（#3084）", () => {
    const onOpenIssue = vi.fn();
    renderPanel(
      {
        ...response([entry()]),
        currentSessions: [
          liveSession,
          { ...liveSession, issueNumber: 3027, tmuxSessionName: "issue-deck-issue-3027", reported: false, costUsd: 0, title: null },
        ],
      },
      { onOpenIssue },
    );
    const section = screen.getByRole("region", { name: "実行中のセッション" });
    // 最初は閉じていて、詳細は出ない（#3134）
    expect(within(section).queryByText("AI使用量表示に現在のセッション使用状況を追加")).toBeNull();
    fireEvent.click(within(section).getByRole("button", { expanded: false }));
    // プラン枠より上
    expect(
      section.compareDocumentPosition(screen.getByText("Claude プラン枠")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 見出しは本数と報告時刻だけ。合計金額は棒の右に出す（#3242）
    expect(within(section).getByText(/^2本/)).toBeTruthy();
    expect(within(section).getByTestId("current-session-total-cost").textContent).toBe("計 $7.35");
    expect(within(section).getByText("AI使用量表示に現在のセッション使用状況を追加")).toBeTruthy();
    expect(within(section).getAllByText("入力を待っています")).toHaveLength(2);
    expect(within(section).getByText("5時間枠の約11.2%")).toBeTruthy();
    expect(within(section).getByText("集計待ち（20秒おきに報告）")).toBeTruthy();
    fireEvent.click(within(section).getAllByTitle("Issueを開く")[0]);
    expect(onOpenIssue).toHaveBeenCalledWith("issue-deck", 3084, null);
  });

  it("実行中のセッションが無ければ1行だけ出す（#3084）", () => {
    renderPanel({ ...response([entry()]), currentSessions: [] });
    expect(screen.getByText("いま実行中のセッションはありません")).toBeTruthy();
  });

  it("スマホでも応答数・入力トークンを5時間枠の割合と並べて出す（#3084）", () => {
    renderPanel({ ...response([entry()]), currentSessions: [liveSession] }, { compact: true });
    const section = screen.getByRole("region", { name: "実行中のセッション" });
    fireEvent.click(within(section).getByRole("button", { expanded: false }));
    expect(within(section).getByText("141応答　入力トークン 12M", { normalizer: (text) => text })).toBeTruthy();
  });

  it("閉じた状態ではセッションごとの金額を積み上げた棒と状態ごとの本数で出し、押すと詳細が開閉する（#3134）", () => {
    renderPanel({
      ...response([entry()]),
      currentSessions: [
        liveSession,
        { ...liveSession, tmuxSessionName: "a", issueNumber: 1, statusTone: "running" as const, statusLabel: "作業中" },
        { ...liveSession, tmuxSessionName: "b", issueNumber: 2, statusTone: "running" as const, statusLabel: "作業中" },
      ],
    });
    const section = screen.getByRole("region", { name: "実行中のセッション" });
    const segments = within(section).getByTestId("current-session-count-bar").children;
    expect(segments).toHaveLength(3);
    // 区間の長さはセッションの金額
    expect((segments[0] as HTMLElement).style.flexGrow).toBe("7.35");
    expect(within(section).getByText("作業中").textContent).toBe("作業中2");
    expect(within(section).getByText("確認待ち").textContent).toBe("確認待ち1");
    expect(within(section).queryByText("応答を終えている")).toBeNull();
    expect(within(section).queryByText("Issue・状態")).toBeNull();

    // 合計金額は棒と同じ行の右側、「押すと詳細」は見出しと同じ行にある（#3242）
    const bar = within(section).getByTestId("current-session-count-bar");
    const total = within(section).getByTestId("current-session-total-cost");
    expect(total.textContent).toBe("計 $22.05");
    expect(total.parentElement).toBe(bar.parentElement);
    expect(bar.nextElementSibling).toBe(total);
    const hint = within(section).getByText("押すと詳細");
    expect(hint.parentElement).toBe(within(section).getByText("実行中のセッション").parentElement);

    const toggle = within(section).getByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(section).getByText("Issue・状態")).toBeTruthy();
    fireEvent.click(toggle);
    expect(within(section).queryByText("Issue・状態")).toBeNull();
  });

  // #3062。「アプリ内AI機能別」は削除した。内訳カードはこの並びの3枚だけ
  it("内訳はリポジトリ別・セッション種別別・Issue・PR別の順で、アプリ内AI機能別は出さない", () => {
    renderPanel(response([entry()]));

    const headings = screen
      .getAllByText(/^(リポジトリ別|セッション種別別|アプリ内AI機能別|Issue・PR別)$/)
      .map((node) => node.textContent);
    expect(headings).toEqual(["リポジトリ別", "セッション種別別", "Issue・PR別"]);
  });

  /**
   * #2779。実装は全体の9割を占めるため、1行のままでは「実装が多い」以外に読めない。
   */
  it("セッション種別別で、実装をフェーズの行に分けて出す", () => {
    renderPanel(
      response([
        entry({
          costUsd: 20,
          planCostUsd: 2,
          implementationCostUsd: 18,
          researchCostUsd: 4,
          codingCostUsd: 7,
          verifyCostUsd: 3,
          wrapupCostUsd: 4,
        }),
      ]),
    );

    const card = screen.getByText("セッション種別別").closest("section");
    expect(card).not.toBeNull();
    const rows = within(card as HTMLElement);
    expect(rows.getByText("計画立案")).toBeTruthy();
    expect(rows.getByText("調査")).toBeTruthy();
    expect(rows.getByText("実装")).toBeTruthy();
    expect(rows.getByText("検証（テスト・Lint・型）")).toBeTruthy();
    expect(rows.getByText("仕上げ（コミット・PR・報告）")).toBeTruthy();
    // 割る前の1行は残さない（フェーズ未集計の行も出ない）。
    expect(rows.queryByText("実装（フェーズ未集計）")).toBeNull();
    // 作業の流れの外の種別が無ければ区切りも出さない（#2954）。
    expect(rows.queryByText("作業の流れの外")).toBeNull();
  });

  /**
   * #2954。金額順ではなく作業の順に並べ、横断質問・その他の手前に区切りを入れる。
   */
  it("セッション種別別を作業の順に並べ、流れの外の手前に区切りを入れる", () => {
    renderPanel(
      response([
        entry({
          sessionId: "impl",
          costUsd: 20,
          planCostUsd: 2,
          researchCostUsd: 4,
          codingCostUsd: 7,
          verifyCostUsd: 3,
          wrapupCostUsd: 4,
        }),
        entry({ sessionId: "plan-review", kind: "plan-review", costUsd: 3 }),
        entry({ sessionId: "question", kind: "question", costUsd: 50 }),
        entry({ sessionId: "actions", kind: "actions", costUsd: 1 }),
      ]),
    );

    const card = screen.getByText("セッション種別別").closest("section");
    const labels = within(card as HTMLElement)
      .getAllByText(
        /^(計画立案|計画レビュー|調査|実装|検証（テスト・Lint・型）|仕上げ（コミット・PR・報告）|CI\/CD・レビュー|作業の流れの外|横断質問)$/,
      )
      .map((element) => element.textContent);
    expect(labels).toEqual([
      "計画立案",
      "計画レビュー",
      "調査",
      "実装",
      "検証（テスト・Lint・型）",
      "仕上げ（コミット・PR・報告）",
      "CI/CD・レビュー",
      "作業の流れの外",
      "横断質問",
    ]);
  });

  /**
   * #3064。種別別は金額だけを見るので、トークンの細い帯を出さない（Issue・PR別には残す）。
   */
  it("セッション種別別にはトークンの帯を出さない", () => {
    renderPanel(response([entry({ costUsd: 20, researchCostUsd: 4, codingCostUsd: 12, wrapupCostUsd: 4 })]));

    const tokenTitle = /^入力 .* \/ 書込 .* \/ 読出 .* \/ 出力 /;
    const kindCard = screen.getByText("セッション種別別").closest("section") as HTMLElement;
    expect(kindCard.querySelectorAll("[title]").length).toBeGreaterThan(0);
    expect([...kindCard.querySelectorAll("[title]")].some((node) => tokenTitle.test(node.getAttribute("title") ?? ""))).toBe(false);
    const issueCard = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect([...issueCard.querySelectorAll("[title]")].some((node) => tokenTitle.test(node.getAttribute("title") ?? ""))).toBe(true);
  });

  it("フェーズを持たない古い行は「実装（フェーズ未集計）」へまとめる", () => {
    renderPanel(response([entry({ costUsd: 20 })]));

    const card = screen.getByText("セッション種別別").closest("section");
    expect(within(card as HTMLElement).getByText("実装（フェーズ未集計）")).toBeTruthy();
  });

  it("ClaudeとCodexを切り替えずに同じ画面へ表示する", () => {
    renderPanel(response([]));
    expect(screen.getByText("Claude プラン枠")).toBeTruthy();
    expect(screen.getByText("Codex プラン枠")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "表示するエージェント" })).toBeNull();
  });

  it("GitHub Actionsの使用量を合計と明細へ表示する", () => {
    renderPanel(response([entry({ source: "github-actions", workflowName: "Claude Code Review", runUrl: "https://github.com/example/run/1", costUsd: 2 })]));
    expect(screen.getAllByText("GitHub Actions").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Actions", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("Claude Code Review", { exact: false })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Actions実行を開く" }).getAttribute("href")).toBe("https://github.com/example/run/1");
  });
  it("同じIssueのセッションは1つの行にまとめ、開いた状態から中の内訳を表示する（#2653）", () => {
    renderPanel(
      response([
        entry({ sessionId: "impl", costUsd: 20, responses: 100 }),
        entry({ sessionId: "plan", agent: "codex", models: ["gpt-5.6"], kind: "plan-review", costUsd: 1, responses: 3, contextTokens: 100, outputTokens: 50 }),
      ]),
    );

    // 一覧だけを見る（「種別別」の内訳にも同じ語が並ぶため）。
    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;

    // 同じIssue番号（#2504）の2セッションは1つの行にまとまる。一番新しい行は既定で開いている。
    expect(within(detail).getAllByText("#2504")).toHaveLength(1);
    expect(within(detail).getByText("2セッション")).toBeTruthy();
    // 「実装」「計画レビュー」は閉じた行の種別ひと目表示（#3410）と、開いた行の種別別内訳
    // （`IssueKindBreakdown`）の両方に出るため件数だけ見る。
    expect(within(detail).getAllByText("実装", { exact: false }).length).toBeGreaterThan(0);
    expect(within(detail).getAllByText("計画レビュー", { exact: false }).length).toBeGreaterThan(0);
    expect(within(detail).getByText("Claude", { exact: false })).toBeTruthy();
    expect(within(detail).getByText("Codex", { exact: false })).toBeTruthy();
    expect(within(detail).getAllByText("100%")).toHaveLength(1);
    expect(within(detail).getByText("1%")).toBeTruthy();
  });

  it("Issue・PR別を開くと、セッション種別別と同じ粒度でモデル・トークン・金額の内訳を出す（#3410）", () => {
    renderPanel(
      response([
        entry({
          costUsd: 20,
          planCostUsd: 2,
          implementationCostUsd: 18,
          researchCostUsd: 4,
          codingCostUsd: 7,
          verifyCostUsd: 3,
          wrapupCostUsd: 4,
          models: ["claude-opus-5"],
        }),
      ]),
    );

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    const breakdown = within(detail).getByText("種別別").closest("div") as HTMLElement;
    // セッション種別別（`Breakdown`）と同じ粒度でフェーズへ割る。
    expect(within(breakdown).getByText("計画立案")).toBeTruthy();
    expect(within(breakdown).getByText("調査")).toBeTruthy();
    expect(within(breakdown).getByText("実装")).toBeTruthy();
    expect(within(breakdown).getByText("検証（テスト・Lint・型）")).toBeTruthy();
    expect(within(breakdown).getByText("仕上げ（コミット・PR・報告）")).toBeTruthy();
    // モデルバッジとトークン量が各行に出る。
    expect(within(breakdown).getAllByText("Opus 5").length).toBeGreaterThan(0);
    expect(within(breakdown).getAllByText(/^\d+(\.\d+)?k$/).length).toBeGreaterThan(0);
  });

  it("閉じたIssue行にも、実行された種別のひと目表示を出す（#3410）", () => {
    renderPanel(
      response([
        entry({ sessionId: "older", issueNumber: 1, kind: "code-review", costUsd: 5, startedAt: "2026-08-29T01:00:00.000Z", endedAt: "2026-08-29T02:00:00.000Z" }),
        entry({ sessionId: "newer", issueNumber: 2, kind: "plan-review", costUsd: 1 }),
      ]),
    );

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    // #1は閉じている（#2の方が新しい）。閉じたままでも種別名がスクリーンリーダー向けに読める。
    expect(within(detail).getByText("実行された種別: コードレビュー", { exact: false })).toBeTruthy();
  });

  it("行をクリックすると開閉し、閉じている行は中のセッションを出さない（#2653）", () => {
    renderPanel(
      response([
        entry({ sessionId: "older", issueNumber: 1, costUsd: 5, startedAt: "2026-08-29T01:00:00.000Z", endedAt: "2026-08-29T02:00:00.000Z" }),
        entry({ sessionId: "newer", issueNumber: 2, kind: "plan-review", costUsd: 1 }),
      ]),
    );

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    // セッション明細（SessionCards）にだけ出る、#1のセッション固有の日時表示で判定する
    // （「実装」は種別ラベルと計画/実装/Actionサマリーの両方に出て見分けが付かないため）。
    const olderRange = `${formatDateTime("2026-08-29T01:00:00.000Z")} 〜 ${formatDateTime("2026-08-29T02:00:00.000Z")}`;

    // 一番新しい活動（#2）だけが既定で開いており、#1は閉じている。
    expect(within(detail).getAllByText("計画レビュー", { exact: false }).length).toBeGreaterThan(0);
    expect(within(detail).queryByText(olderRange)).toBeNull();

    fireEvent.click(within(detail).getByRole("button", { name: /#1/ }));
    expect(within(detail).getByText(olderRange)).toBeTruthy();
  });

  it("内訳は集計側の金額を出し、持たない行だけ「約」を付けた近似にする（#2626）", () => {
    renderPanel(
      response([
        // キャッシュ読み出しがトークンの大半を占めるセッション。トークン比で按分すると
        // 出力側が$0.24まで落ちるが、実際の内訳は入力$20.10 / 出力$5.00。
        entry({
          sessionId: "exact",
          inputTokens: 20_000,
          cacheCreateTokens: 1_000_000,
          cacheReadTokens: 20_000_000,
          contextTokens: 21_020_000,
          outputTokens: 200_000,
          costUsd: 25.1,
          inputCostUsd: 20.1,
          outputCostUsd: 5,
        }),
      ]),
    );

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect(within(detail).getByText("$20.10", { exact: false })).toBeTruthy();
    expect(within(detail).getByText("$5.00", { exact: false })).toBeTruthy();
    expect(within(detail).queryByText("約", { exact: false })).toBeNull();
  });

  it("内訳を持たない行はトークン比の近似を「約」付きで出す", () => {
    renderPanel(
      response([entry({ sessionId: "legacy", contextTokens: 9_000, outputTokens: 1_000, costUsd: 10 })]),
    );

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect(within(detail).getAllByText("約", { exact: false }).length).toBeGreaterThan(0);
    expect(within(detail).getByText("$9.00", { exact: false })).toBeTruthy();
    expect(within(detail).getByText("$1.00", { exact: false })).toBeTruthy();
  });

  it("使ったモデルをセッション名の下にチップで出す（#2646）", () => {
    renderPanel(
      response([entry({ sessionId: "multi-model", models: ["claude-opus-5", "claude-sonnet-5"] })]),
    );

    // 種別別内訳（`IssueKindBreakdown`、#3410）にも同じモデルのチップが出るため件数だけ見る。
    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect(within(detail).getAllByText("Opus 5").length).toBeGreaterThan(0);
    expect(within(detail).getAllByText("Sonnet 5").length).toBeGreaterThan(0);
  });

  it("Plan modeの内訳があるセッションだけ、料金の下に計画/実装を分けて出す（#2646）", () => {
    renderPanel(
      response([
        entry({ sessionId: "with-plan", costUsd: 5, planCostUsd: 1.2, implementationCostUsd: 3.8 }),
        entry({ sessionId: "without-plan", costUsd: 2 }),
      ]),
    );

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    // セッション明細側の計画/実装の内訳（PhaseSplitNote）は、区分のあるセッションだけに出る
    // （「計画」「$1.20」単体は計画/実装/Actionサマリー（#2670）にも出るため、結合済みの
    // 一意な文字列で判定する）。
    expect(within(detail).getByText("計画 $1.20・実装 $3.80", { exact: false })).toBeTruthy();
  });

  it("金額は常にドルで出し、単位を切り替える導線は無い", () => {
    renderPanel(response([entry({ costUsd: 20 })]));

    expect(screen.getAllByText("$20.00").length).toBeGreaterThan(0);
    expect(screen.queryByRole("group", { name: "金額の単位" })).toBeNull();
    expect(screen.queryByRole("button", { name: "枠%" })).toBeNull();
  });

  it("Issueを開く導線は、リポジトリとIssue番号が揃っている行にだけ出す", () => {
    const onOpenIssue = vi.fn();
    renderPanel(
      response([
        entry({ sessionId: "impl" }),
        entry({ sessionId: "q", kind: "question", repository: null, issueNumber: null, costUsd: 1 }),
      ]),
      { onOpenIssue },
    );

    const buttons = screen.getAllByRole("button", { name: "Issueを開く" });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]);
    expect(onOpenIssue).toHaveBeenCalledWith("issue-deck", 2504, null);
  });

  it("Issue番号もPR番号も無いセッションは「Issue・PR別」に行を出さない（#3427）", () => {
    renderPanel(
      response([
        entry({ sessionId: "impl" }),
        entry({ sessionId: "q", kind: "question", repository: null, issueNumber: null, costUsd: 1 }),
      ]),
      { onOpenIssue: vi.fn() },
    );

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect(within(detail).getAllByTitle(/を開く/)).toHaveLength(1);
    expect(screen.queryByText("（Issue未特定）")).toBeNull();
  });

  it("Issue番号が無くPR番号だけの行は「PR #番号」と表示し、PRを開く導線を出す（#2650）", () => {
    const onOpenIssue = vi.fn();
    renderPanel(
      response([
        entry({
          sessionId: "pr",
          kind: "other",
          source: "github-actions",
          issueNumber: null,
          prNumber: 2648,
          costUsd: 1,
        }),
      ]),
      { onOpenIssue },
    );

    expect(screen.getByText(/PR #2648/)).toBeTruthy();
    expect(screen.queryByText("（Issue未特定）")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "PRを開く" }));
    expect(onOpenIssue).toHaveBeenCalledWith("issue-deck", null, 2648);
  });

  it("タイトルを解決できた行は番号の下に表示し、解決できない行は出さない（#2686）", () => {
    const data = response([entry({ sessionId: "impl" })]);
    data.byIssue[0].title = "AI使用量画面にissue・PR別のタイトル表示機能を追加";

    renderPanel(data);

    expect(screen.getByText("AI使用量画面にissue・PR別のタイトル表示機能を追加")).toBeTruthy();
  });

  it("タイトルを解決できていない行はタイトルの表示を出さない（#2686）", () => {
    const { container } = renderPanel(response([entry({ sessionId: "impl" })]));

    expect(container.querySelector("p.truncate[title]")).toBeNull();
  });

  it("リポジトリ別は円グラフで、金額の上位5件と「その他」にまとめる（#3060）", () => {
    const entries = Array.from({ length: 7 }, (_unused, index) =>
      entry({
        sessionId: `repo-${index}`,
        repository: `repository-${index}`,
        costUsd: 7 - index,
      }),
    );
    renderPanel(response(entries));

    const card = screen.getByText("リポジトリ別").closest("section") as HTMLElement;
    // 名前が出るのは上位5件だけ。6位・7位は「その他」へ入り、件数を添える
    const chart = within(card).getByRole("img");
    expect(within(chart).getByText("repository-0")).toBeTruthy();
    expect(within(chart).getByText("repository-4")).toBeTruthy();
    expect(within(chart).queryByText("repository-5")).toBeNull();
    expect(within(chart).getByText("その他")).toBeTruthy();
    expect(within(chart).getByText("2リポジトリ")).toBeTruthy();
    // 全体は28ドル。最大の切れは7/28で25.0%、その他は3/28で10.7%
    expect(chart.getAttribute("aria-label")).toContain("repository-0 25.0%（$7.00）");
    expect(chart.getAttribute("aria-label")).toContain("その他 10.7%（$3.00）");
    // 棒＋トークン帯や「すべて表示」の展開ボタンは持たない
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).getByText("7リポジトリ・上位5件＋その他")).toBeTruthy();
  });

  it("リポジトリ別の円グラフは、Claude・Codex・Actionsもトークンも区別しない（#3060）", () => {
    renderPanel(response([entry()]));

    const card = screen.getByText("リポジトリ別").closest("section") as HTMLElement;
    expect(within(card).queryByTitle("入力 1k / 書込 2k / 読出 7k / 出力 500")).toBeNull();
    expect(within(card).queryByTitle("Claude $20.00 / Codex $0.00 / GitHub Actions $0.00")).toBeNull();
  });

  it("明細の棒を、素の入力・キャッシュ書込・キャッシュ読出・出力の4つへ塗り分ける（#2628）", () => {
    renderPanel(response([entry()]));

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;

    // 棒のtitleに4区分ぶんの内訳が出る（キャッシュを1色へ潰さない）。1セッションだけのIssueは
    // グループの帯とセッションの帯が同じ内訳になるため、複数本出ていてよい。
    expect(within(detail).getAllByTitle("入力 1k / 書込 2k / 読出 7k / 出力 500").length).toBeGreaterThan(0);

    // 棒の下の数値も4項目。
    expect(within(detail).getByText("入力 1k")).toBeTruthy();
    expect(within(detail).getByText("書込 2k")).toBeTruthy();
    expect(within(detail).getByText("読出 7k")).toBeTruthy();
    expect(within(detail).getByText("出力 500")).toBeTruthy();

    // 凡例は単価の倍率を添える（薄い＝安いことを色だけに背負わせない）。
    expect(screen.getByText("1.25〜2倍")).toBeTruthy();
    expect(screen.getByText("0.1倍")).toBeTruthy();
    expect(screen.queryByText("入力（キャッシュ含む）")).toBeNull();
  });

  it("合計の「入力トークン」に、期間全体のキャッシュ内訳を出す（#2628・#3254）", () => {
    renderPanel(response([entry()]));
    expect(screen.getByText("内訳 入力 1k・書込 2k・読出 7k")).toBeTruthy();
  });

  it("Issue・PR別の行を、金額の太い棒とトークンの細い帯の二段にする（#2633）。日別・種別別はトークンを出さない（#3038・#3064）", () => {
    renderPanel(response([entry()]));

    // 日別の縦棒。内側はモデルの重さ（tier）別の濃淡で、棒には数値を書けないのでツールチップへ出す
    // （エージェント別内訳・使われたモデル名も添える。#3396）。
    const daily = screen.getByText("日別").closest("section") as HTMLElement;
    // タイトルの区切りは全角空白。テスト側の照合が空白を畳むので正規表現で受ける。
    expect(
      within(daily).getByTitle(
        /^2026-08-30\s+\$20\.00\s+100応答\s+・\s+Claude \$20\.00 \/ Codex \$0\.00 \/ GitHub Actions \$0\.00\s+・\s+モデル: Opus 5$/,
      ),
    ).toBeTruthy();
    // トークンの細い帯は日別では出さない。
    expect(within(daily).queryByTitle("入力 1k / 書込 2k / 読出 7k / 出力 500")).toBeNull();

    // Issue・PR別は細い帯（トークンの4区分。長さもトークン量に比例）を出す。
    // リポジトリ別は円グラフ（#3060）、種別別は金額の棒だけ（#3064）で、帯を持たない。
    const issues = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect(within(issues).getAllByTitle("入力 1k / 書込 2k / 読出 7k / 出力 500").length).toBeGreaterThan(0);
    const breakdown = screen.getByText("セッション種別別").closest("section") as HTMLElement;
    expect(within(breakdown).queryByTitle("入力 1k / 書込 2k / 読出 7k / 出力 500")).toBeNull();

    // 凡例は「どちらの棒の色か」を先に言う（内訳の手前に置く）。
    expect(screen.getByText("太い棒＝金額")).toBeTruthy();
    expect(screen.getByText("細い帯＝トークン")).toBeTruthy();
  });

  it("日別は期間の全日を並べ、金額0の日も日付を残す（#3038）", () => {
    // 7日（8/24〜8/30）のうち記録があるのは8/30だけ。残りの6日も日付と0の印を出す。
    renderPanel(response([entry()]));

    const daily = screen.getByText("日別").closest("section") as HTMLElement;
    for (const day of ["8/24", "8/25", "8/26", "8/27", "8/28", "8/29", "8/30"]) {
      expect(within(daily).getByText(day)).toBeTruthy();
    }
    expect(within(daily).getAllByTitle(/応答/)).toHaveLength(7);
    // タイトルの区切りは全角空白。テスト側の照合が空白を畳むので正規表現で受ける。
    expect(
      within(daily).getByTitle(
        /^2026-08-29\s+\$0\.00\s+0応答\s+・\s+Claude \$0\.00 \/ Codex \$0\.00 \/ GitHub Actions \$0\.00$/,
      ),
    ).toBeTruthy();
    // 縦軸は金額（$0と、最大を含む目盛り）。
    expect(within(daily).getByText("$0")).toBeTruthy();
    expect(within(daily).getByText("$20")).toBeTruthy();
  });

  it("日別に、期間の全日の平均を点線と金額で出す（#3038）", () => {
    // 合計$20を7日で割ると$2.86。0の日も分母に入れる。
    renderPanel(response([entry()]));

    const daily = screen.getByText("日別").closest("section") as HTMLElement;
    expect(within(daily).getByText("平均 $2.86")).toBeTruthy();
    expect(within(daily).getByText("期間の平均")).toBeTruthy();
  });

  it("日別の凡例は、Claude／Codexをモデルの重さ（tier）の濃淡で示す（#3396）", () => {
    renderPanel(response([entry()]));

    const daily = screen.getByText("日別").closest("section") as HTMLElement;
    expect(within(daily).getByText("Claude")).toBeTruthy();
    expect(within(daily).getByText("Codex")).toBeTruthy();
    expect(within(daily).getByText("濃いほど重いモデル")).toBeTruthy();
    expect(within(daily).getByText("GitHub Actions")).toBeTruthy();
  });

  it("金額の棒でGitHub ActionsぶんをClaudeから引く（Codexが短く出ない。#2633）", () => {
    // ActionsはClaude Codeなので`byAgent.claude`にも入っている。引かずに描くと、Claudeの帯が
    // Actionsのぶんまで伸び、残りとして描いていたCodexが消える。
    renderPanel(
      response([
        entry({ sessionId: "local-claude", costUsd: 10 }),
        entry({ sessionId: "local-codex", agent: "codex", costUsd: 10 }),
        entry({ sessionId: "actions", source: "github-actions", costUsd: 20 }),
      ]),
    );

    const daily = screen.getByText("日別").closest("section") as HTMLElement;
    // タイトルの区切りは全角空白。テスト側の照合が空白を畳むので正規表現で受ける。
    const dayCell = within(daily).getByTitle(
      /^2026-08-30\s+\$40\.00\s+300応答\s+・\s+Claude \$10\.00 \/ Codex \$10\.00 \/ GitHub Actions \$20\.00\s+・\s+モデル: Opus 5$/,
    );
    const bar = dayCell.querySelector(".flex-col-reverse") as HTMLElement;
    // 縦棒なので、積み上げの割合は高さで持つ。
    const heights = [...bar.querySelectorAll("span")].map((span) => (span as HTMLElement).style.height);
    expect(heights).toEqual(["25%", "25%", "50%"]);
  });

  it("スマホ（compact）でもPCと同じ横棒グラフ・展開の一覧を出す（#2628・#2653）", () => {
    renderPanel(response([entry()]), { compact: true });

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    // 表は幅46remの横スクロールになるため使わない（PC・スマホ共通で使わなくなった）。
    expect(within(detail).queryByRole("table")).toBeNull();
    // グループ見出しと、展開済みのカードで料金・内訳を落とさず出す。
    expect(within(detail).getByText("#2504")).toBeTruthy();
    expect(within(detail).getAllByText("$20.00").length).toBeGreaterThan(0);
    expect(within(detail).getByText("読出 7k")).toBeTruthy();
  });

  it("記録が無いときは、報告待ちであることを出す", () => {
    renderPanel(response([]));
    expect(screen.getByText(/記録がありません。サブPCまたはGitHub Actionsから報告されると出ます/)).toBeTruthy();
  });

  it("Issueを開くと計画・実装・Actionのサマリーを出し、実績の無いフェーズは行を出さない（#2670）", () => {
    renderPanel(
      response([
        // 計画（Plan mode）を含むローカルセッション。
        entry({ sessionId: "with-plan", costUsd: 5, planCostUsd: 2, implementationCostUsd: 3, models: ["claude-sonnet-4-5"] }),
        // GitHub Actions実行。Action行だけがここから出る（Issueには他にAction実行が無い）。
        entry({
          sessionId: "actions",
          source: "github-actions",
          costUsd: 1,
          responses: 1,
          inputTokens: 100,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 20,
          contextTokens: 100,
          models: ["claude-haiku-4-5"],
        }),
      ]),
    );

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect(within(detail).getAllByText("計画", { exact: false }).length).toBeGreaterThan(0);
    expect(within(detail).getAllByText("実装", { exact: false }).length).toBeGreaterThan(0);
    // "Action"は「GitHub Actions」にも部分一致するため件数だけ見る。金額もセッション明細側の
    // PhaseSplitNote（結合テキスト）と部分一致し得るため、いずれも件数だけを見る。
    expect(within(detail).getAllByText("Action", { exact: false }).length).toBeGreaterThan(0);
    expect(within(detail).getAllByText("$2.00", { exact: false }).length).toBeGreaterThan(0);
    expect(within(detail).getAllByText("$3.00", { exact: false }).length).toBeGreaterThan(0);
    expect(within(detail).getAllByText("$1.00", { exact: false }).length).toBeGreaterThan(0);
  });

  it("計画やActionの実績が無いIssueでは、その行を出さない（#2670）", () => {
    // Plan modeを使わず、GitHub Actionsの実行も無いローカル実装セッションのみ。
    renderPanel(response([entry({ sessionId: "impl-only", costUsd: 4 })]));

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    // 「実装」は種別ラベルとサマリーの両方に出るが、「計画」「Action」はサマリーにしか出ない。
    // 実績が無ければ出さない方針（ユーザー指示）なので、両方とも出現しない。
    expect(within(detail).queryByText("計画", { exact: false })).toBeNull();
    expect(within(detail).queryByText("Action", { exact: false })).toBeNull();
  });

  it("金額は従量課金相当として表示し、API換算の注意書きを表示しない", () => {
    const { container } = renderPanel(response([entry()]));
    expect(within(container).getByText("従量課金相当")).toBeTruthy();
    expect(within(container).queryByText(/金額はAPI換算の目安です/)).toBeNull();
    expect(within(container).queryByText(/サブスクの実費ではありません/)).toBeNull();
  });

  it("quotaPercentが入っているIssueだけ、直近5時間枠のおよそ何%かを表示する（#2988）", () => {
    const data = response([entry()]);
    data.byIssue[0].quotaPercent = 12.4;
    renderPanel(data);

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect(within(detail).getByText("直近5時間枠のおよそ12%")).toBeTruthy();
  });

  it("quotaPercentがnullのIssueには表示しない", () => {
    const data = response([entry()]);
    data.byIssue[0].quotaPercent = null;
    renderPanel(data);

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect(within(detail).queryByText(/直近5時間枠のおよそ/)).toBeNull();
  });
  describe("ヘッダーと期間選択の配置（#3257）", () => {
    it("経過時間を見出しと同じ行に、更新ボタンをその行の右端に置き、見出し下の説明文は出さない", () => {
      renderPanel(response([entry()]));
      const heading = screen.getByRole("heading", { name: "AI使用量" });
      const header = heading.parentElement as HTMLElement;
      expect(within(header).getByText(/subpc から/)).toBeTruthy();
      const refresh = within(header).getByRole("button", { name: "更新" });
      expect(header.lastElementChild).toBe(refresh);
      expect(screen.queryByText(/GitHub Actionsが使ったトークン/)).toBeNull();
    });

    it("期間選択はプラン枠より下、日別より上に置く", () => {
      renderPanel(response([entry()]));
      const period = screen.getByRole("group", { name: "集計する期間" });
      const claudePlan = screen.getByText("Claude プラン枠");
      expect(claudePlan.compareDocumentPosition(period) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        period.compareDocumentPosition(screen.getByText("日別")) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("選択した期間の応答が届くまでは集計を隠し、プラン枠と実行中のセッションは出したままにする", () => {
      // 前の期間（7日）の応答が残っている状態で、30日を選んだところ
      renderPanel({ ...response([entry()]), currentSessions: [] }, { days: 30, isLoading: true });
      expect(screen.getByText("Claude プラン枠")).toBeTruthy();
      expect(screen.getByRole("region", { name: "実行中のセッション" })).toBeTruthy();
      // 集計の値は出さず、実物と同じ枠のスケルトンで待つ
      expect(screen.getByText("集計を読み込み中")).toBeTruthy();
      expect(screen.queryByText(/1応答/)).toBeNull();
      expect(screen.queryByText("記録がありません")).toBeNull();
    });
  });

  describe("取得待ちのスケルトン（#3304）", () => {
    it("何も届いていなくても、見出しと枠を先に出す", () => {
      renderPanel(null, { plan: { data: null, error: null }, isLoading: true });

      expect(screen.getByRole("heading", { name: "AI使用量" })).toBeTruthy();
      expect(screen.getByRole("group", { name: "集計する期間" })).toBeTruthy();
      expect(screen.getByRole("region", { name: "実行中のセッション" })).toBeTruthy();
      for (const label of [
        "Claude プラン枠",
        "Codex プラン枠",
        "従量課金相当",
        "日別",
        "リポジトリ別",
        "セッション種別別",
        "Issue・PR別",
      ]) {
        expect(screen.getByText(label)).toBeTruthy();
      }
      expect(screen.getByText("集計を読み込み中")).toBeTruthy();
      expect(screen.getByText("実行中のセッションを読み込み中")).toBeTruthy();
      // Claudeは週間・5時間の2行、Codexは週間の1行
      expect(screen.getAllByText("週間を読み込み中")).toHaveLength(2);
      expect(screen.getAllByText("5時間を読み込み中")).toHaveLength(1);
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(10);
    });

    it("点滅は動きを減らす設定のときに止める", () => {
      renderPanel(null, { plan: { data: null, error: null } });
      const bones = [...document.querySelectorAll('[data-slot="skeleton"]')];
      expect(bones.length).toBeGreaterThan(0);
      for (const bone of bones) expect(bone.className).toContain("motion-reduce:animate-none");
    });

    it("集計が先に届いたら、プラン枠だけスケルトンのまま集計を出す", () => {
      renderPanel(
        { ...response([entry()]), currentSessions: [] },
        { plan: { data: null, error: null } },
      );

      expect(screen.getByText("従量課金相当")).toBeTruthy();
      expect(screen.queryByText("集計を読み込み中")).toBeNull();
      expect(screen.queryByText("実行中のセッションを読み込み中")).toBeNull();
      expect(screen.getByText("いま実行中のセッションはありません")).toBeTruthy();
      // プラン枠は届くまでメーターの形で待つ
      expect(screen.getAllByText("週間を読み込み中")).toHaveLength(2);
      expect(screen.getByText("5時間を読み込み中")).toBeTruthy();
    });

    it("プラン枠の取得に失敗したら、スケルトンのまま止めずエラーを出す", () => {
      renderPanel(response([entry()]), {
        plan: { data: null, error: "プラン枠の取得に失敗しました (500)" },
      });

      expect(screen.queryByText("5時間を読み込み中")).toBeNull();
      expect(screen.getAllByText("プラン枠の取得に失敗しました (500)").length).toBeGreaterThan(0);
    });

    it("集計の取得に失敗したら、スケルトンを止めてエラーだけを出す", () => {
      renderPanel(null, { error: "取得に失敗しました (500)", plan: PLAN_LOADED });

      expect(screen.getByText("取得に失敗しました (500)")).toBeTruthy();
      expect(screen.queryByText("集計を読み込み中")).toBeNull();
      expect(screen.queryByText("実行中のセッションを読み込み中")).toBeNull();
    });
  });
});
