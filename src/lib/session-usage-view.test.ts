import { describe, expect, it } from "vitest";

import {
  buildCurrentSessionUsage,
  buildIssueQuotaPercents,
  buildQuotaEstimate,
  buildRepositoryPieSlices,
  buildSessionUsageSummary,
  fillUsageDays,
  formatSessionElapsed,
  formatUsageTokens,
  formatUsageUsd,
  isUsageKindInWorkFlow,
  niceAxisScale,
  sessionUsageCostSplit,
  sessionUsageIssueKey,
  sessionUsageModelLabel,
  sessionUsagePeriodStartMs,
  sessionUsageImplementationPhases,
  sessionUsageKindLabel,
  sessionUsagePhaseSplit,
  type CurrentSessionInput,
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

  it("Issue単位の種別別内訳（byKind）は、全体のbyKindと同じ粒度・並びで作る（#3410）", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({
          sessionId: "plan-review",
          kind: "plan-review",
          costUsd: 0.5,
          models: ["claude-opus-5"],
        }),
        // フェーズを拾えない実装行（フェーズ別の金額列を持たない）は unsplit へ入る。
        entry({ sessionId: "impl", kind: "implementation", costUsd: 9, models: ["claude-sonnet-4-5"] }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    const issue = summary.byIssue[0];
    // 並びは全体のbyKindと同じ「作業の順」（#2954）。
    expect(issue.byKind.map((row) => row.key)).toEqual(["plan-review", "implementation-unsplit"]);
    expect(issue.byKind.map((row) => row.costUsd)).toEqual([0.5, 9]);
    expect(issue.byKind.map((row) => row.models)).toEqual([["claude-opus-5"], ["claude-sonnet-4-5"]]);
  });

  it("Issue単位のbyKindも、実装をフェーズごとの行へ割る（#3410）", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({
          costUsd: 20,
          planCostUsd: 2,
          implementationCostUsd: 18,
          researchCostUsd: 4,
          codingCostUsd: 7,
          verifyCostUsd: 3,
          wrapupCostUsd: 4,
        }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    const issue = summary.byIssue[0];
    expect(issue.byKind.map((row) => row.key)).toEqual([
      "phase-plan",
      "phase-research",
      "phase-coding",
      "phase-verify",
      "phase-wrapup",
    ]);
    expect(issue.byKind.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(20, 6);
  });

  it("Issue単位のbyKindは、同じ種別・同じセッションのモデルを重複除去して集約する（#3410）", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "a", kind: "code-review", costUsd: 1, models: ["claude-sonnet-4-5"] }),
        entry({ sessionId: "b", kind: "code-review", costUsd: 1, models: ["claude-sonnet-4-5"] }),
        entry({ sessionId: "c", kind: "code-review", costUsd: 1, models: ["claude-opus-5"] }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    const issue = summary.byIssue[0];
    expect(issue.byKind).toHaveLength(1);
    expect(issue.byKind[0].sessions).toBe(3);
    expect(issue.byKind[0].models).toEqual(["claude-sonnet-4-5", "claude-opus-5"]);
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

  it("リポジトリ別は金額の多い順、種別別は作業の順に出す", () => {
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

    // 金額（実装5・未集計4・調査2・仕上げ2・計画1）ではなく作業の順に並ぶ（#2954）。
    expect(summary.byKind.map((row) => row.key)).toEqual([
      "phase-plan",
      "phase-research",
      "phase-coding",
      "implementation-unsplit",
      "phase-wrapup",
    ]);
    // 割ったあとの合計が、割る前の合計と一致すること（カードの合計が動かない）。
    expect(summary.byKind.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(14, 6);
    // 本数は`byKind`から数えられない（1本が最大4行に現れる）ので、別に持つ。
    expect(summary.implementationSessions).toBe(2);
  });

  /**
   * #2954。金額順では期間を切り替えるたびに行の位置が入れ替わり、作業の流れに沿って読めなかった。
   */
  it("種別別は計画→レビュー→GitHub Actions→流れの外→未知の種別の順に並べる", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "unknown-small", kind: "new-kind-a", costUsd: 1 }),
        entry({ sessionId: "unknown-large", kind: "new-kind-b", costUsd: 30 }),
        entry({ sessionId: "other", kind: "other", costUsd: 40 }),
        entry({ sessionId: "question", kind: "question", costUsd: 50 }),
        entry({ sessionId: "actions", kind: "actions", costUsd: 2 }),
        entry({ sessionId: "code-review", kind: "code-review", costUsd: 20 }),
        entry({ sessionId: "plan-review", kind: "plan-review", costUsd: 3 }),
        entry({
          sessionId: "impl",
          costUsd: 10,
          planCostUsd: 1,
          researchCostUsd: 2,
          codingCostUsd: 5,
          wrapupCostUsd: 2,
        }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.byKind.map((row) => row.key)).toEqual([
      "phase-plan",
      "plan-review",
      "phase-research",
      "phase-coding",
      "phase-wrapup",
      "code-review",
      "actions",
      "question",
      "other",
      "new-kind-b",
      "new-kind-a",
    ]);
    expect(isUsageKindInWorkFlow("actions")).toBe(true);
    expect(isUsageKindInWorkFlow("question")).toBe(false);
    expect(isUsageKindInWorkFlow("new-kind-a")).toBe(false);
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

  it("日別の金額をエージェント×モデルの重さ（tier）別に積む（#3396）", () => {
    // 単価表（ai-model-pricing.ts）でclaude-opus-5はtier1、claude-sonnet-5はtier2
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "opus", models: ["claude-opus-5"], costUsd: 4 }),
        entry({ sessionId: "sonnet", models: ["claude-sonnet-5"], costUsd: 6 }),
        entry({ sessionId: "unknown", models: ["claude-unknown-model"], costUsd: 1 }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    const tiers = summary.byDay[0].modelTiers.claude;
    expect(tiers.costUsd).toEqual([0, 4, 6, 0]);
    expect(tiers.unresolvedCostUsd).toBe(1);
  });

  it("GitHub Actionsのentryはモデルtierへ積まない（日別グラフは単色のまま表す）", () => {
    const summary = buildSessionUsageSummary({
      entries: [entry({ source: "github-actions", models: ["claude-opus-5"], costUsd: 5 })],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    const tiers = summary.byDay[0].modelTiers.claude;
    expect(tiers.costUsd).toEqual([0, 0, 0, 0]);
    expect(tiers.unresolvedCostUsd).toBe(0);
  });

  it("1セッションが複数モデルを使った場合、最も重い1つへ金額をまとめて計上する", () => {
    // claude-haiku-4-5はtier3、claude-opus-5はtier1（こちらが重い）
    const summary = buildSessionUsageSummary({
      entries: [entry({ models: ["claude-haiku-4-5", "claude-opus-5"], costUsd: 9 })],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.byDay[0].modelTiers.claude.costUsd).toEqual([0, 9, 0, 0]);
  });

  it("日別で使われたモデルのラベルを重複除去して持つ", () => {
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "a", models: ["claude-opus-5"] }),
        entry({ sessionId: "b", models: ["claude-opus-5", "claude-haiku-4-5"] }),
      ],
      nowMs: NOW_MS,
      days: 7,
      reportedAt: null,
    });

    expect(summary.byDay[0].modelLabels).toEqual(["Opus 5", "Haiku 4.5"]);
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

  it("種別は日本語のラベルにする（知らない種別はそのまま出す）", () => {
    expect(sessionUsageKindLabel("plan-review")).toBe("計画レビュー");
    // #2832でシェル側が送り始めた種別。ラベルが無いと画面に`code-review`が生で出る。
    expect(sessionUsageKindLabel("code-review")).toBe("コードレビュー");
    expect(sessionUsageKindLabel("unknown")).toBe("unknown");
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
    ).toEqual({ plan: 0, research: 2, coding: 6, verify: 0, wrapup: 2 });

    expect(
      sessionUsageImplementationPhases(
        entry({ costUsd: 10, planCostUsd: 1, researchCostUsd: 2, codingCostUsd: 5, wrapupCostUsd: 2 }),
      ),
    ).toEqual({ plan: 1, research: 2, coding: 5, verify: 0, wrapup: 2 });

    // 検証を持つ行（#3064）。検証も計画の引き算に入る。
    expect(
      sessionUsageImplementationPhases(
        entry({ costUsd: 10, researchCostUsd: 2, codingCostUsd: 3, verifyCostUsd: 3, wrapupCostUsd: 1 }),
      ),
    ).toEqual({ plan: 1, research: 2, coding: 3, verify: 3, wrapup: 1 });
  });

  it("3つの合計が金額を超えていたら、その比のまま金額へ収める", () => {
    // 走っている途中のセッションは、内訳のほうが先に書かれた金額より新しいことがある。
    expect(
      sessionUsageImplementationPhases(
        entry({ costUsd: 10, researchCostUsd: 4, codingCostUsd: 12, wrapupCostUsd: 4 }),
      ),
    ).toEqual({ plan: 0, research: 2, coding: 6, verify: 0, wrapup: 2 });
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

describe("buildQuotaEstimate", () => {
  // resetsAt=06:00Zの5時間前=01:00Z がウィンドウ開始。
  const RESETS_AT_SEC = Date.parse("2026-08-30T06:00:00.000Z") / 1000;
  const FIVE_HOURS_MS = 5 * 60 * 60_000;

  it("ウィンドウ内のClaudeの合計費用を使用率(%)で割ったレートを返す", () => {
    const estimate = buildQuotaEstimate({
      entries: [
        entry({ costUsd: 10, endedAt: "2026-08-30T02:00:00.000Z" }), // ウィンドウ内
        entry({ costUsd: 5, endedAt: "2026-08-30T04:00:00.000Z" }), // ウィンドウ内
        entry({ costUsd: 100, endedAt: "2026-08-30T00:30:00.000Z" }), // ウィンドウより前
        entry({ costUsd: 1000, agent: "codex", endedAt: "2026-08-30T02:00:00.000Z" }), // Codexは対象外
      ],
      usedPercent: 30,
      resetsAt: RESETS_AT_SEC,
      windowDurationMs: FIVE_HOURS_MS,
    });

    expect(estimate).not.toBeNull();
    expect(estimate?.windowCostUsd).toBe(15);
    expect(estimate?.usdPerPercent).toBeCloseTo(15 / 30);
    expect(estimate?.windowStartMs).toBe(Date.parse("2026-08-30T01:00:00.000Z"));
  });

  it("resetsAtが取得できていなければnull", () => {
    expect(
      buildQuotaEstimate({
        entries: [entry()],
        usedPercent: 30,
        resetsAt: null,
        windowDurationMs: FIVE_HOURS_MS,
      }),
    ).toBeNull();
  });

  it("使用率が0以下ならnull", () => {
    expect(
      buildQuotaEstimate({
        entries: [entry()],
        usedPercent: 0,
        resetsAt: RESETS_AT_SEC,
        windowDurationMs: FIVE_HOURS_MS,
      }),
    ).toBeNull();
  });

  it("ウィンドウ内にClaudeの活動が無ければnull", () => {
    expect(
      buildQuotaEstimate({
        entries: [entry({ endedAt: "2026-08-30T00:00:00.000Z" })],
        usedPercent: 30,
        resetsAt: RESETS_AT_SEC,
        windowDurationMs: FIVE_HOURS_MS,
      }),
    ).toBeNull();
  });
});

describe("sessionUsageIssueKey", () => {
  it("issueNumberがあればリポジトリ#Issue番号をキーにする", () => {
    expect(sessionUsageIssueKey({ repository: "issue-deck", issueNumber: 2988, prNumber: null })).toBe(
      "issue-deck#2988",
    );
  });

  it("issueNumberが無ければprNumberを##で区切って使う（#2650）", () => {
    expect(sessionUsageIssueKey({ repository: "issue-deck", issueNumber: null, prNumber: 42 })).toBe(
      "issue-deck##42",
    );
  });
});

describe("buildIssueQuotaPercents", () => {
  const quota = {
    usdPerPercent: 2,
    windowStartMs: Date.parse("2026-08-30T01:00:00.000Z"),
    windowCostUsd: 60,
  };

  it("ウィンドウ内のIssue別費用をレートで割った%を、DB取得済みentries全体から計算する", () => {
    const percents = buildIssueQuotaPercents(
      [
        entry({ issueNumber: 1, costUsd: 4, endedAt: "2026-08-30T02:00:00.000Z" }),
        // 期間の外（前日）だがウィンドウ内。UsageIssue.entriesには乗らないが、按分には含めたい行。
        entry({ issueNumber: 1, costUsd: 2, endedAt: "2026-08-30T01:30:00.000Z" }),
        entry({ issueNumber: 2, costUsd: 3, endedAt: "2026-08-30T03:00:00.000Z" }),
      ],
      quota,
    );
    expect(percents.get("issue-deck#1")).toBe(3); // (4+2)/2
    expect(percents.get("issue-deck#2")).toBe(1.5); // 3/2
  });

  it("換算レート自体が無ければ空のMap", () => {
    expect(buildIssueQuotaPercents([entry()], null).size).toBe(0);
  });

  it("ウィンドウより前の活動しか無いIssueはキーに含まれない", () => {
    const percents = buildIssueQuotaPercents(
      [entry({ issueNumber: 1, costUsd: 4, endedAt: "2026-08-30T00:00:00.000Z" })],
      quota,
    );
    expect(percents.has("issue-deck#1")).toBe(false);
  });

  it("Codexの活動は無視する", () => {
    const percents = buildIssueQuotaPercents(
      [entry({ agent: "codex", issueNumber: 1, costUsd: 4, endedAt: "2026-08-30T02:00:00.000Z" })],
      quota,
    );
    expect(percents.has("issue-deck#1")).toBe(false);
  });
});

describe("sessionUsageModelLabel", () => {
  it("Claudeのモデルは系統名とバージョン番号に短縮し、日付サフィックスは落とす（#3396）", () => {
    expect(sessionUsageModelLabel("claude-opus-5")).toBe("Opus 5");
    expect(sessionUsageModelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(sessionUsageModelLabel("claude-sonnet-4-5")).toBe("Sonnet 4.5");
    expect(sessionUsageModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(sessionUsageModelLabel("claude-fable-5-1")).toBe("Fable 5.1");
  });

  it("バージョン番号が取れないモデルは系統名だけ返す", () => {
    expect(sessionUsageModelLabel("claude-mythos")).toBe("Mythos");
  });

  it("Codexなど対応表に無いモデルはそのまま出す", () => {
    expect(sessionUsageModelLabel("gpt-6-sol")).toBe("GPT-6 Sol");
    expect(sessionUsageModelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  });
});

describe("fillUsageDays", () => {
  it("記録の無い日を0の行で埋め、期間の全日（日本時間）を古い順に並べる（#3038）", () => {
    // 8/28と8/30だけに記録がある3日間。間の8/29が抜けたままだと縦棒が連続して見える。
    const summary = buildSessionUsageSummary({
      entries: [
        entry({ sessionId: "a", endedAt: "2026-08-28T02:00:00.000Z", costUsd: 5 }),
        entry({ sessionId: "b", endedAt: "2026-08-30T02:00:00.000Z", costUsd: 7 }),
      ],
      nowMs: NOW_MS,
      days: 3,
      reportedAt: null,
    });
    expect(summary.byDay.map((day) => day.date)).toEqual(["2026-08-28", "2026-08-30"]);

    const days = fillUsageDays(summary.byDay, summary.since, summary.until);

    expect(days.map((day) => day.date)).toEqual(["2026-08-28", "2026-08-29", "2026-08-30"]);
    expect(days.map((day) => day.costUsd)).toEqual([5, 0, 7]);
    // 埋めた行も、画面が読む形（エージェント別・実行経路別）を持つ。
    expect(days[1].byAgent.claude.costUsd).toBe(0);
    expect(days[1].bySource["github-actions"].costUsd).toBe(0);
  });

  it("記録が1件も無い期間でも、全日を0で並べる", () => {
    const days = fillUsageDays(
      [],
      new Date(Date.parse("2026-08-27T15:00:00.000Z")).toISOString(),
      new Date(NOW_MS).toISOString(),
    );
    // 日本時間の8/28 0:00（UTC 8/27 15:00）から8/30まで。
    expect(days.map((day) => day.date)).toEqual(["2026-08-28", "2026-08-29", "2026-08-30"]);
  });

  it("期間の外に出た日は落とさず並べる（合計と棒の総和を合わせる）", () => {
    const stray = fillUsageDays(
      [
        {
          date: "2026-09-01",
          sessions: 1,
          responses: 1,
          inputTokens: 0,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          contextTokens: 0,
          outputTokens: 0,
          costUsd: 3,
          byAgent: {
            claude: { sessions: 1, responses: 1, inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, contextTokens: 0, outputTokens: 0, costUsd: 3 },
            codex: { sessions: 0, responses: 0, inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, contextTokens: 0, outputTokens: 0, costUsd: 0 },
          },
          bySource: {
            local: { sessions: 1, responses: 1, inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, contextTokens: 0, outputTokens: 0, costUsd: 3 },
            "github-actions": { sessions: 0, responses: 0, inputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, contextTokens: 0, outputTokens: 0, costUsd: 0 },
          },
          modelTiers: {
            claude: { costUsd: [0, 0, 0, 0], unresolvedCostUsd: 3 },
            codex: { costUsd: [0, 0, 0, 0], unresolvedCostUsd: 0 },
          },
          modelLabels: [],
        },
      ],
      new Date(Date.parse("2026-08-29T15:00:00.000Z")).toISOString(),
      new Date(NOW_MS).toISOString(),
    );
    expect(stray.map((day) => day.date)).toEqual(["2026-08-30", "2026-09-01"]);
  });

  it("解釈できない期間はそのまま返す", () => {
    expect(fillUsageDays([], "invalid", "invalid")).toEqual([]);
  });
});

describe("niceAxisScale", () => {
  it("最大を含む切りの良い上限と、0から始まる等間隔の目盛りを返す", () => {
    // 445.4÷4≒111なので、間隔は100では足りず200になる（目盛りは4本前後に収める）。
    expect(niceAxisScale(445.4)).toEqual({ max: 600, step: 200, ticks: [0, 200, 400, 600] });
    expect(niceAxisScale(261.9)).toEqual({ max: 300, step: 100, ticks: [0, 100, 200, 300] });
    expect(niceAxisScale(20)).toEqual({ max: 20, step: 5, ticks: [0, 5, 10, 15, 20] });
  });

  it("小さな金額でも小数の誤差を持ち込まない", () => {
    expect(niceAxisScale(0.3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it("全日が0のときは$1を上限にして目盛りだけ描ける", () => {
    expect(niceAxisScale(0)).toEqual({ max: 1, step: 1, ticks: [0, 1] });
    expect(niceAxisScale(Number.NaN)).toEqual({ max: 1, step: 1, ticks: [0, 1] });
  });
});

describe("buildRepositoryPieSlices（#3060）", () => {
  const group = (key: string, costUsd: number) => ({ key, costUsd });

  it("金額の上位5件と、残りをまとめた「その他」に畳む", () => {
    const slices = buildRepositoryPieSlices([
      group("a", 60),
      group("b", 20),
      group("c", 10),
      group("d", 5),
      group("e", 3),
      group("f", 1),
      group("g", 1),
    ]);

    expect(slices.map((slice) => slice.label)).toEqual(["a", "b", "c", "d", "e", "その他"]);
    const other = slices[5];
    expect(other.isOther).toBe(true);
    expect(other.costUsd).toBe(2);
    expect(other.repositoryCount).toBe(2);
    expect(slices.reduce((sum, slice) => sum + slice.fraction, 0)).toBeCloseTo(1);
    expect(slices[0].fraction).toBeCloseTo(0.6);
  });

  it("並びは入力の順ではなく金額の多い順", () => {
    const slices = buildRepositoryPieSlices([group("small", 1), group("big", 9)]);
    expect(slices.map((slice) => slice.key)).toEqual(["big", "small"]);
  });

  it("5件以内なら「その他」を作らない", () => {
    const slices = buildRepositoryPieSlices([group("a", 2), group("b", 1)]);
    expect(slices.some((slice) => slice.isOther)).toBe(false);
  });

  it("金額が0のリポジトリは切れにも件数にも入れない", () => {
    const slices = buildRepositoryPieSlices([group("a", 4), group("zero", 0)]);
    expect(slices.map((slice) => slice.key)).toEqual(["a"]);
    expect(slices[0].fraction).toBe(1);
  });

  it("リポジトリを判定できなかった行（空文字のキー）は「(不明)」の名前で出す", () => {
    const [slice] = buildRepositoryPieSlices([group("", 3)]);
    expect(slice.label).toBe("(不明)");
    expect(slice.isOther).toBe(false);
  });

  it("金額の合計が0なら切れを返さない", () => {
    expect(buildRepositoryPieSlices([])).toEqual([]);
    expect(buildRepositoryPieSlices([group("a", 0)])).toEqual([]);
  });
});

describe("buildCurrentSessionUsage（#3084）", () => {
  const baseSession: CurrentSessionInput = {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-3084",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 3084,
    firstSeenAt: "2026-09-19T01:00:00.000Z",
    agent: "claude",
    statusLabel: "作業中",
    statusTone: "running",
    models: ["claude-opus-5"],
  };
  const usage = (overrides: Partial<SessionUsageEntry> = {}): SessionUsageEntry => ({
    agent: "claude",
    source: "local",
    sessionId: "a",
    host: "subpc",
    kind: "implementation",
    repository: "issue-deck",
    issueNumber: 3084,
    prNumber: null,
    responses: 10,
    inputTokens: 100,
    cacheCreateTokens: 200,
    cacheReadTokens: 700,
    outputTokens: 50,
    contextTokens: 1_000,
    costUsd: 2,
    models: ["claude-opus-5"],
    startedAt: "2026-09-19T01:00:00.000Z",
    endedAt: "2026-09-19T01:30:00.000Z",
    ...overrides,
  });

  it("同じホスト・リポジトリ・Issueで、開始以降に終わった行を足し込む", () => {
    const [row] = buildCurrentSessionUsage({
      sessions: [baseSession],
      entries: [
        usage(),
        usage({ sessionId: "subagent", costUsd: 1, responses: 5, models: ["claude-haiku-4-5"] }),
        // 前回のセッション（開始より前に終わった）は拾わない
        usage({ sessionId: "old", endedAt: "2026-09-19T00:59:00.000Z", costUsd: 100 }),
        // 別ホスト・別Issue・GitHub Actionsは拾わない
        usage({ sessionId: "h", host: "mainpc", costUsd: 100 }),
        usage({ sessionId: "i", issueNumber: 1, costUsd: 100 }),
        usage({ sessionId: "gha", source: "github-actions", costUsd: 100 }),
      ],
      quota: null,
    });
    expect(row).toMatchObject({
      repository: "issue-deck",
      reported: true,
      costUsd: 3,
      responses: 15,
      contextTokens: 2_000,
      quotaPercent: null,
    });
    expect(row.models).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
  });

  it("5時間枠の割合はウィンドウ内のClaudeの行だけで換算する", () => {
    const [row] = buildCurrentSessionUsage({
      sessions: [baseSession],
      entries: [usage({ costUsd: 4 })],
      quota: { usdPerPercent: 2, windowStartMs: Date.parse("2026-09-19T00:00:00.000Z"), windowCostUsd: 10 },
    });
    expect(row.quotaPercent).toBe(2);
  });

  it("行が無いセッションは集計待ちとして末尾に並べ、モデルはセッション側の値で補う", () => {
    const rows = buildCurrentSessionUsage({
      sessions: [
        { ...baseSession, issueNumber: 1, tmuxSessionName: "issue-deck-issue-1" },
        baseSession,
        { ...baseSession, issueNumber: 2, tmuxSessionName: "issue-deck-issue-2" },
      ],
      entries: [usage({ costUsd: 1 }), usage({ sessionId: "b", issueNumber: 2, costUsd: 5 })],
      quota: null,
    });
    expect(rows.map((row) => row.issueNumber)).toEqual([2, 3084, 1]);
    expect(rows[2]).toMatchObject({ reported: false, costUsd: 0, models: ["claude-opus-5"] });
  });
});

describe("formatSessionElapsed（#3084）", () => {
  const start = "2026-09-19T00:00:00.000Z";
  const at = (minutes: number) => Date.parse(start) + minutes * 60_000;
  it("分・時間・日の単位で出す", () => {
    expect(formatSessionElapsed(start, at(0.5))).toBe("1分未満");
    expect(formatSessionElapsed(start, at(42))).toBe("42分");
    expect(formatSessionElapsed(start, at(60))).toBe("1時間");
    expect(formatSessionElapsed(start, at(78))).toBe("1時間18分");
    expect(formatSessionElapsed(start, at(60 * 26))).toBe("1日2時間");
  });
});
