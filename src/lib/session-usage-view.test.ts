import { describe, expect, it } from "vitest";

import {
  buildPhaseBreakdown,
  buildSessionUsageSummary,
  formatUsageTokens,
  formatUsageUsd,
  sessionUsageCostSplit,
  sessionUsageModelLabel,
  sessionUsagePeriodStartMs,
  sessionUsageImplementationPhases,
  sessionUsagePhaseSplit,
  type SessionUsageEntry,
} from "@/lib/session-usage-view";

/**
 * 「AI使用量」画面（#2504）の集計。
 *
 * ここで一番効くのは**日付の境界**と**期間の切り出し**。日別の棒は日本時間で切る決まりで
 * （本番VPS・CIはUTCで動く）、ずれると「深夜に走ったぶんが前日に付く」形で静かに間違える。
 */

function entry(overrides: Partial<SessionUsageEntry> = {}): SessionUsageEntry {
  const contextTokens =
    overrides.contextTokens ??
    (overrides.inputTokens ?? 100) + (overrides.cacheCreateTokens ?? 200) + (overrides.cacheReadTokens ?? 700);
  return {
    agent: "claude",
    sessionId: "s1",
    host: "subpc",
    kind: "implementation",
    repository: "issue-deck",
    issueNumber: 2504,
    prNumber: null,
    responses: 10,
    inputTokens: 100,
    cacheCreateTokens: 200,
    cacheReadTokens: 700,
    outputTokens: 50,
    contextTokens,
    costUsd: 1,
    models: ["claude-opus-5"],
    startedAt: "2026-08-30T01:00:00.000Z",
    endedAt: "2026-08-30T02:00:00.000Z",
    ...overrides,
  };
}

/** 2026-08-30 12:00 JST */
const NOW_MS = Date.parse("2026-08-30T03:00:00.000Z");

describe("sessionUsagePeriodStartMs", () => {
  it("今日を含む日数で、日本時間のその日の0:00に切る", () => {
    // 1日 = 今日の0:00（JST）= 前日15:00Z
    expect(new Date(sessionUsagePeriodStartMs(NOW_MS, 1)).toISOString()).toBe(
      "2026-08-29T15:00:00.000Z",
    );
    // 7日 = 6日前の0:00（JST）
    expect(new Date(sessionUsagePeriodStartMs(NOW_MS, 7)).toISOString()).toBe(
      "2026-08-23T15:00:00.000Z",
    );
  });
});

describe("buildSessionUsageSummary", () => {
  it("期間の外のセッションを落とす", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "in", endedAt: "2026-08-30T02:00:00.000Z" }),
        entry({ sessionId: "out", endedAt: "2026-08-20T02:00:00.000Z" }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.totals.sessions).toBe(1);
    expect(summary.byIssue[0].entries.map((item) => item.sessionId)).toEqual(["in"]);
  });

  it("日別のバケットは日本時間で切る（UTCの日付では前日に付いてしまう）", () => {
    // 2026-08-30T16:00Z は日本時間で8/31の1:00。UTCのまま数えると8/30に入る。
    const summary = buildSessionUsageSummary({
      entries: [entry({ endedAt: "2026-08-30T16:00:00.000Z" })],
      // 判定に使う「今」も後ろへずらしておく（期間の外に落ちないように）
      nowMs: Date.parse("2026-08-31T00:00:00.000Z"),
      days: 7,
      reportedAt: null,
    });

    expect(summary.byDay.map((day) => day.date)).toEqual(["2026-08-31"]);
  });

  it("Issue単位でまとめ、その中の転記を開始日時の新しい順に並べる", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({
          sessionId: "plan",
          kind: "plan-review",
          costUsd: 0.5,
          responses: 1,
          startedAt: "2026-08-30T02:00:00.000Z",
        }),
        entry({
          sessionId: "impl",
          kind: "implementation",
          costUsd: 9,
          responses: 100,
          startedAt: "2026-08-30T01:00:00.000Z",
        }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.byIssue).toHaveLength(1);
    const issue = summary.byIssue[0];
    expect(issue.issueNumber).toBe(2504);
    expect(issue.sessions).toBe(2);
    expect(issue.responses).toBe(101);
    // 金額が小さくても、新しく始まったセッションが先頭になる。
    expect(issue.entries.map((item) => item.sessionId)).toEqual(["plan", "impl"]);
    // 種別も金額の多い順
    expect(issue.kinds).toEqual(["implementation", "plan-review"]);
  });

  it("同じIssue番号なら、PR番号の有無・値が違うセッションも1つにまとめる（#2653）", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "impl", issueNumber: 2650, prNumber: null, costUsd: 2 }),
        // そのIssueのPR（#2651）へのGitHub Actionsレビュー実行。ブランチ名issue-2650から
        // issueNumberは解決できているが、prNumberも一緒に付いている。
        entry({
          sessionId: "actions",
          issueNumber: 2650,
          prNumber: 2651,
          source: "github-actions",
          costUsd: 1,
        }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.byIssue).toHaveLength(1);
    expect(summary.byIssue[0].issueNumber).toBe(2650);
    expect(summary.byIssue[0].sessions).toBe(2);
    expect(summary.byIssue[0].costUsd).toBe(3);
  });

  it("Issue番号が無いPR起点の実行は、PR番号が違えば別の行のままにする（#2650）", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "release-a", issueNumber: null, prNumber: 100, costUsd: 1 }),
        entry({ sessionId: "release-b", issueNumber: null, prNumber: 200, costUsd: 1 }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.byIssue).toHaveLength(2);
    expect(summary.byIssue.map((issue) => issue.prNumber).sort()).toEqual([100, 200]);
  });

  it("Issueを最新セッションの開始日時が新しい順に並べる", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ issueNumber: 1, sessionId: "older-expensive", costUsd: 100 }),
        entry({
          issueNumber: 2,
          sessionId: "current-cheap",
          costUsd: 0.01,
          startedAt: "2026-08-30T02:30:00.000Z",
          endedAt: "2026-08-30T02:31:00.000Z",
        }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.byIssue.map((issue) => issue.issueNumber)).toEqual([2, 1]);
    expect(summary.byIssue[0].latestStartedAt).toBe("2026-08-30T02:30:00.000Z");
  });

  it("Issue番号を持たないセッションも落とさず、リポジトリ単位でまとめる", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "impl" }),
        entry({
          sessionId: "question",
          kind: "question",
          issueNumber: null,
          costUsd: 2,
          startedAt: "2026-08-30T02:00:00.000Z",
        }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    // 合計と明細が合っていること（落とすと合わなくなる）
    expect(summary.totals.costUsd).toBe(3);
    expect(summary.byIssue.reduce((sum, issue) => sum + issue.costUsd, 0)).toBe(3);
    expect(summary.byIssue.map((issue) => issue.issueNumber)).toEqual([null, 2504]);
  });

  it("明細は上位200件で切り、落としたぶんは件数と合計で返す（合計・内訳には入れたまま）", () => {
    // 金額の違う210件のIssue。合計は全件から作り、明細だけが切られる。
    const entries = Array.from({ length: 210 }, (_unused, index) =>
      entry({ sessionId: `s${index}`, issueNumber: index + 1, costUsd: 210 - index }),
    );
    const summary = buildSessionUsageSummary({
      entries,
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.totals.sessions).toBe(210);
    expect(summary.byIssue).toHaveLength(200);
    // 落ちるのは金額の少ないほう（$10〜$1の10件）。
    expect(summary.omittedIssues).toBe(10);
    expect(summary.omittedIssueCostUsd).toBe(55);
    expect(summary.byRepository[0].sessions).toBe(210);
  });

  it("リポジトリ・種別ごとの内訳を金額の多い順に出す", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "a", repository: "issue-deck", costUsd: 1 }),
        entry({ sessionId: "b", repository: "dayspan", costUsd: 5, issueNumber: 1 }),
        entry({ sessionId: "c", repository: null, costUsd: 3, issueNumber: null, kind: "other" }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.byRepository.map((row) => row.key)).toEqual(["dayspan", "", "issue-deck"]);
    // 実装はフェーズごとの行へ割る（#2779）。この3件はフェーズを持たないので「未集計」へ入る。
    expect(summary.byKind.map((row) => row.key)).toEqual(["implementation-unsplit", "other"]);
  });

  it("実装はフェーズごとの行へ割り、合計は変わらない（#2779）", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({
          sessionId: "a",
          costUsd: 10,
          planCostUsd: 1,
          implementationCostUsd: 9,
          researchCostUsd: 2,
          codingCostUsd: 5,
          wrapupCostUsd: 2,
        }),
        // フェーズを持たない行（pollerを入れ替える前の報告）は1行にまとめる。
        entry({ sessionId: "b", costUsd: 4 }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.byKind.map((row) => row.key)).toEqual([
      "phase-coding",
      "implementation-unsplit",
      "phase-research",
      "phase-wrapup",
      "phase-plan",
    ]);
    // 割ったあとの合計が、割る前の合計と一致すること（カードの合計が動かない）。
    expect(summary.byKind.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(14, 6);
    // 本数は`byKind`から数えられない（1本が最大4行に現れる）ので、別に持つ。
    expect(summary.implementationSessions).toBe(2);
  });

  it("合計・日別・リポジトリ別・種別別をClaudeとCodexに分けて保持する", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "claude", agent: "claude", costUsd: 3 }),
        entry({ sessionId: "codex", agent: "codex", models: ["gpt-5.6"], costUsd: 2 }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.totalsByAgent.claude.costUsd).toBe(3);
    expect(summary.totalsByAgent.codex.costUsd).toBe(2);
    expect(summary.byDay[0].byAgent.codex.sessions).toBe(1);
    expect(summary.byRepository[0].byAgent.claude.sessions).toBe(1);
    expect(summary.byKind[0].byAgent.codex.sessions).toBe(1);
  });
});

describe("整形", () => {
  it("金額は桁に応じて小数を落とす", () => {
    expect(formatUsageUsd(10029.4)).toBe("$10,029");
    expect(formatUsageUsd(995.34)).toBe("$995.3");
    expect(formatUsageUsd(1.256)).toBe("$1.26");
    // 1セント未満でも0にしない（発生していること自体が要点）
    expect(formatUsageUsd(0.0004)).toBe("$0.01");
  });

  it("トークン数は単位で畳む", () => {
    expect(formatUsageTokens(12_852_563_529)).toBe("12.85G");
    expect(formatUsageTokens(116_593_336)).toBe("117M");
    expect(formatUsageTokens(39_198)).toBe("39k");
  });
});

describe("sessionUsageCostSplit", () => {
  it("集計側の内訳があればそのまま使う（トークン比で割り直さない）", () => {
    // 入力側のトークンが99%を占めるが、金額の内訳は入力$20.1 / 出力$5.0。
    const split = sessionUsageCostSplit(
      entry({
        contextTokens: 21_020_000,
        outputTokens: 200_000,
        costUsd: 25.1,
        inputCostUsd: 20.1,
        outputCostUsd: 5.0,
      }),
    );
    expect(split).toEqual({ inputCostUsd: 20.1, outputCostUsd: 5.0, approximate: false });
  });

  it("内訳を持たない行だけトークン比の近似へ落とし、近似だと分かるようにする", () => {
    const split = sessionUsageCostSplit(
      entry({ contextTokens: 900, outputTokens: 100, costUsd: 10, inputCostUsd: null, outputCostUsd: null }),
    );
    expect(split).toEqual({ inputCostUsd: 9, outputCostUsd: 1, approximate: true });
  });

  it("片方だけの行・トークンが0の行でも壊れない", () => {
    // 片側しか無い行は内訳として使えない（合計が料金にならない）。
    expect(sessionUsageCostSplit(entry({ contextTokens: 900, outputTokens: 100, costUsd: 10, inputCostUsd: 9 })))
      .toMatchObject({ approximate: true });
    expect(sessionUsageCostSplit(entry({ contextTokens: 0, outputTokens: 0, costUsd: 0 })))
      .toEqual({ inputCostUsd: 0, outputCostUsd: 0, approximate: true });
  });
});

describe("sessionUsageImplementationPhases", () => {
  it("計画は引き算で出し、4つの合計が必ず金額と一致する（#2779）", () => {
    // 集計側は`ExitPlanMode`が無いセッションのplanCostUsdをnullで送る（#2646の意味を変えない）。
    // その場合の計画は0であって不明ではないので、残り3つとの差から出す。
    expect(
      sessionUsageImplementationPhases(
        entry({ costUsd: 10, planCostUsd: null, researchCostUsd: 2, codingCostUsd: 6, wrapupCostUsd: 2 }),
      ),
    ).toEqual({ plan: 0, research: 2, coding: 6, wrapup: 2 });

    expect(
      sessionUsageImplementationPhases(
        entry({ costUsd: 10, planCostUsd: 1, researchCostUsd: 2, codingCostUsd: 5, wrapupCostUsd: 2 }),
      ),
    ).toEqual({ plan: 1, research: 2, coding: 5, wrapup: 2 });
  });

  it("3つの合計が金額を超えていたら、その比のまま金額へ収める", () => {
    // 走っている途中のセッションは、内訳のほうが先に書かれた金額より新しいことがある。
    expect(
      sessionUsageImplementationPhases(
        entry({ costUsd: 10, researchCostUsd: 4, codingCostUsd: 12, wrapupCostUsd: 4 }),
      ),
    ).toEqual({ plan: 0, research: 2, coding: 6, wrapup: 2 });
  });

  it("3つ揃っていない行はnullを返す（フェーズ未集計として扱う）", () => {
    expect(sessionUsageImplementationPhases(entry({ costUsd: 10 }))).toBeNull();
    expect(
      sessionUsageImplementationPhases(
        entry({ costUsd: 10, researchCostUsd: 2, codingCostUsd: 6, wrapupCostUsd: null }),
      ),
    ).toBeNull();
  });
});

describe("sessionUsagePhaseSplit", () => {
  it("計画/実装の内訳があればそのまま返す", () => {
    const split = sessionUsagePhaseSplit(
      entry({ costUsd: 5, planCostUsd: 1.2, implementationCostUsd: 3.8 }),
    );
    expect(split).toEqual({ planCostUsd: 1.2, implementationCostUsd: 3.8 });
  });

  it("Plan modeを使っていないセッション（両方null）は近似せずnullを返す", () => {
    expect(sessionUsagePhaseSplit(entry({ planCostUsd: null, implementationCostUsd: null }))).toBeNull();
  });

  it("片方だけしか無い行もnullを返す（合算だけを信用する）", () => {
    expect(sessionUsagePhaseSplit(entry({ planCostUsd: 1.2, implementationCostUsd: null }))).toBeNull();
  });
});

describe("buildPhaseBreakdown", () => {
  it("GitHub Actionsの行は正確なトークンのままActionへ計上する", () => {
    const breakdown = buildPhaseBreakdown([
      entry({
        source: "github-actions",
        inputTokens: 1000,
        cacheCreateTokens: 200,
        cacheReadTokens: 800,
        outputTokens: 100,
        contextTokens: 2000,
        costUsd: 4,
        models: ["claude-haiku-4-5-20251001"],
      }),
    ]);

    expect(breakdown.action).toMatchObject({
      costUsd: 4,
      inputTokens: 1000,
      cacheCreateTokens: 200,
      cacheReadTokens: 800,
      outputTokens: 100,
      sessions: 1,
      models: ["claude-haiku-4-5-20251001"],
    });
    expect(breakdown.plan.sessions).toBe(0);
    expect(breakdown.implementation.sessions).toBe(0);
  });

  it("計画/実装の区分がある行は、金額はそのまま・トークンは金額比で按分する", () => {
    const breakdown = buildPhaseBreakdown([
      entry({
        contextTokens: 1000,
        outputTokens: 200,
        costUsd: 10,
        planCostUsd: 4,
        implementationCostUsd: 6,
        models: ["claude-sonnet-4-5"],
      }),
    ]);

    // 金額は正確
    expect(breakdown.plan.costUsd).toBe(4);
    expect(breakdown.implementation.costUsd).toBe(6);
    // トークンは金額比（0.4 / 0.6）で按分した近似
    expect(breakdown.plan.contextTokens).toBeCloseTo(400);
    expect(breakdown.plan.outputTokens).toBeCloseTo(80);
    expect(breakdown.implementation.contextTokens).toBeCloseTo(600);
    expect(breakdown.implementation.outputTokens).toBeCloseTo(120);
    expect(breakdown.plan.models).toEqual(["claude-sonnet-4-5"]);
    expect(breakdown.implementation.models).toEqual(["claude-sonnet-4-5"]);
  });

  it("計画/実装の区分が無い行（Plan mode未使用）は、按分せず全額・全トークンを実装へ計上する", () => {
    const breakdown = buildPhaseBreakdown([
      entry({
        contextTokens: 1000,
        outputTokens: 200,
        costUsd: 10,
        planCostUsd: null,
        implementationCostUsd: null,
      }),
    ]);

    expect(breakdown.plan.sessions).toBe(0);
    expect(breakdown.implementation).toMatchObject({
      costUsd: 10,
      contextTokens: 1000,
      outputTokens: 200,
      sessions: 1,
    });
  });

  it("複数セッションのモデルを重複除去して集約する", () => {
    const breakdown = buildPhaseBreakdown([
      entry({ sessionId: "a", planCostUsd: null, implementationCostUsd: null, models: ["claude-sonnet-4-5"] }),
      entry({ sessionId: "b", planCostUsd: null, implementationCostUsd: null, models: ["claude-sonnet-4-5"] }),
      entry({ sessionId: "c", planCostUsd: null, implementationCostUsd: null, models: ["claude-opus-5"] }),
    ]);

    expect(breakdown.implementation.models).toEqual(["claude-sonnet-4-5", "claude-opus-5"]);
    expect(breakdown.implementation.sessions).toBe(3);
  });

  it("実績の無いフェーズはsessionsが0のまま返る（画面はここで行を出し分ける）", () => {
    const breakdown = buildPhaseBreakdown([]);
    expect(breakdown.plan.sessions).toBe(0);
    expect(breakdown.implementation.sessions).toBe(0);
    expect(breakdown.action.sessions).toBe(0);
  });
});

describe("sessionUsageModelLabel", () => {
  it("Claudeのモデルは世代・日付サフィックスを落として短縮表示する", () => {
    expect(sessionUsageModelLabel("claude-opus-5")).toBe("Opus");
    expect(sessionUsageModelLabel("claude-sonnet-4-5")).toBe("Sonnet");
    expect(sessionUsageModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku");
  });

  it("Codexなど対応表に無いモデルはそのまま出す", () => {
    expect(sessionUsageModelLabel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });
});
