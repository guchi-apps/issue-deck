// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionUsagePanel } from "@/components/dashboard/session-usage-panel";
import type { ClaudeApiUsageSummary } from "@/hooks/use-claude-api-usage";
import type { SessionUsageResponse } from "@/hooks/use-session-usage";
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
    planUsage: { claude: null, codex: null },
    planNotConfigured: { claude: true, codex: true },
  };
}

function renderPanel(data: SessionUsageResponse, props: Record<string, unknown> = {}) {
  return render(
    <SessionUsagePanel
      data={data}
      isLoading={false}
      error={null}
      days={7}
      onChangeDays={() => {}}
      onRefresh={() => {}}
      {...props}
    />,
  );
}

/** issue-deck本体のAI機能が使ったAPIの内訳（#2631で設定の「状態」から移した） */
function apiUsageSummary(): ClaudeApiUsageSummary {
  const totals = {
    calls: 5,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  return {
    measuringSince: NOW_MS - 86_400_000,
    totalLast24h: totals,
    totalLast7d: totals,
    features: [
      {
        key: "issue_summary",
        label: "Issueの要約",
        last24h: totals,
        last7d: totals,
        models: [{ model: "claude-haiku-4-5", last24h: totals, last7d: totals }],
      },
    ],
  };
}

afterEach(() => cleanup());

describe("SessionUsagePanel", () => {
  // #2631。設定の「状態」にあった機能別のAPI消費内訳をここへ移した。渡されなければ出さない
  it("claudeApiUsageを渡したときだけアプリ内AI機能別を出す", () => {
    const { unmount } = renderPanel(response([]));
    expect(screen.queryByText("アプリ内AI機能別")).toBeNull();
    unmount();

    renderPanel(response([]), {
      claudeApiUsage: { data: apiUsageSummary(), isLoading: false, error: null },
    });
    expect(screen.getByText("アプリ内AI機能別")).toBeTruthy();
    expect(screen.getByText("Issueの要約", { exact: false })).toBeTruthy();
  });

  /**
   * #2752。以前は明細を挟んだ画面のいちばん下にあった。同じ「何にAIを使ったか」の内訳なので
   * セッション種別別の真下へ置く。
   */
  it("アプリ内AI機能別をセッション種別別の直後に置く", () => {
    renderPanel(response([entry()]), {
      claudeApiUsage: { data: apiUsageSummary(), isLoading: false, error: null },
    });

    const headings = screen
      .getAllByText(/^(リポジトリ別|セッション種別別|アプリ内AI機能別|Issue・PR別)$/)
      .map((node) => node.textContent);
    expect(headings).toEqual([
      "リポジトリ別",
      "セッション種別別",
      "アプリ内AI機能別",
      "Issue・PR別",
    ]);
  });

  /**
   * #2752。セッションの記録がまだ届いていないと上の内訳ごと描かれない。このアプリ自身の消費は
   * セッションと無関係に数えられているので、**そのときは単独で出す**。
   */
  it("セッションの記録がまだ無くてもアプリ内AI機能別は出す", () => {
    renderPanel(null as unknown as SessionUsageResponse, {
      claudeApiUsage: { data: apiUsageSummary(), isLoading: false, error: null },
    });
    expect(screen.getByText("アプリ内AI機能別")).toBeTruthy();
    expect(screen.queryByText("セッション種別別")).toBeNull();
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
    // 「実装」は種別ラベルと計画/実装/Actionサマリー（#2670）の両方に出るため件数だけ見る。
    expect(within(detail).getAllByText("実装", { exact: false }).length).toBeGreaterThan(0);
    expect(within(detail).getByText("計画レビュー", { exact: false })).toBeTruthy();
    expect(within(detail).getByText("Claude", { exact: false })).toBeTruthy();
    expect(within(detail).getByText("Codex", { exact: false })).toBeTruthy();
    expect(within(detail).getAllByText("100%")).toHaveLength(1);
    expect(within(detail).getByText("1%")).toBeTruthy();
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
    expect(within(detail).getByText("計画レビュー", { exact: false })).toBeTruthy();
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

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    expect(within(detail).getByText("Opus")).toBeTruthy();
    expect(within(detail).getByText("Sonnet")).toBeTruthy();
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

  it("Issueを開けない行にも、他の行と棒グラフの右端をそろえる同じ寸法のプレースホルダーを描く（#2685）", () => {
    const onOpenIssue = vi.fn();
    renderPanel(
      response([
        entry({ sessionId: "impl" }),
        entry({ sessionId: "q", kind: "question", repository: null, issueNumber: null, costUsd: 1 }),
      ]),
      { onOpenIssue },
    );

    const detail = screen.getByText("Issue・PR別").closest("section") as HTMLElement;
    // 見えるボタンは開ける行の1つだけだが（既存テストのとおり）、開けない行にも
    // 同じ`<Button>`がDOMには存在し、`aria-hidden`で隠れているだけ（＝棒グラフの
    // 右端をそろえるための幅を確保している）。`title`属性はaria-hiddenでも
    // DOMに残るため、これで両方の行のボタンを拾う。
    const allOpenButtons = within(detail).getAllByTitle(/を開く/);
    expect(allOpenButtons).toHaveLength(2);
    const hiddenButton = allOpenButtons.find(
      (button) => button.getAttribute("aria-hidden") === "true",
    );
    expect(hiddenButton).toBeTruthy();
    expect((hiddenButton as HTMLButtonElement).disabled).toBe(true);
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

    expect(container.querySelector("p.truncate")).toBeNull();
  });

  it("リポジトリ別内訳は上位5件を表示し、ボタンで残りを展開・折りたためる", () => {
    const entries = Array.from({ length: 6 }, (_unused, index) =>
      entry({
        sessionId: `repo-${index}`,
        repository: `repository-${index}`,
        costUsd: 6 - index,
      }),
    );
    renderPanel(response(entries));

    const breakdown = screen.getByText("リポジトリ別").closest("section") as HTMLElement;
    expect(within(breakdown).getByText("repository-0")).toBeTruthy();
    expect(within(breakdown).getByText("repository-4")).toBeTruthy();
    expect(within(breakdown).queryByText("repository-5")).toBeNull();

    fireEvent.click(within(breakdown).getByRole("button", { name: "すべて表示（残り 1 リポジトリ）" }));
    expect(within(breakdown).getByText("repository-5")).toBeTruthy();

    fireEvent.click(within(breakdown).getByRole("button", { name: "上位5件のみ表示" }));
    expect(within(breakdown).queryByText("repository-5")).toBeNull();
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

  it("合計の「コンテキスト」に、期間全体のキャッシュ内訳を出す（#2628）", () => {
    renderPanel(response([entry()]));
    expect(screen.getByText("入力 1k・書込 2k・読出 7k")).toBeTruthy();
  });

  it("日別・内訳の行を、金額の太い棒とトークンの細い帯の二段にする（#2633）", () => {
    renderPanel(response([entry()]));

    // 太い棒は金額で、内側はエージェントの割合。棒には数値を書けないのでツールチップへ出す。
    const daily = screen.getByText("日別").closest("section") as HTMLElement;
    expect(within(daily).getByTitle("Claude $20.00 / Codex $0.00 / GitHub Actions $0.00")).toBeTruthy();
    // 細い棒はトークンの4区分。長さもトークン量に比例させる。
    expect(within(daily).getByTitle("入力 1k / 書込 2k / 読出 7k / 出力 500")).toBeTruthy();

    // リポジトリ別・種別別にも同じ二段を出す。
    const breakdown = screen.getByText("リポジトリ別").closest("section") as HTMLElement;
    expect(within(breakdown).getByTitle("入力 1k / 書込 2k / 読出 7k / 出力 500")).toBeTruthy();

    // 凡例は「どちらの棒の色か」を先に言う。
    expect(screen.getByText("太い棒＝金額")).toBeTruthy();
    expect(screen.getByText("細い帯＝トークン")).toBeTruthy();
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
    const bar = within(daily).getByTitle(
      "Claude $10.00 / Codex $10.00 / GitHub Actions $20.00",
    );
    const widths = [...bar.querySelectorAll("span")].map((span) => (span as HTMLElement).style.width);
    expect(widths).toEqual(["25%", "25%", "50%"]);
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
});
