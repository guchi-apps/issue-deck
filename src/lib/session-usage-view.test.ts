import { describe, expect, it } from "vitest";

import {
  buildQuotaScale,
  buildSessionUsageSummary,
  formatQuotaPercent,
  formatUsageAmount,
  formatUsageTokens,
  formatUsageUsd,
  sessionUsageCostSplit,
  sessionUsageModelLabel,
  sessionUsagePeriodStartMs,
  sessionUsagePhaseSplit,
  toQuotaPercent,
  type SessionUsageEntry,
} from "@/lib/session-usage-view";

/**
 * 「AI使用量」画面（#2504）の集計。
 *
 * ここで一番効くのは**日付の境界**と**期間の切り出し**。日別の棒は日本時間で切る決まりで
 * （本番VPS・CIはUTCで動く）、ずれると「深夜に走ったぶんが前日に付く」形で静かに間違える。
 * 次に効くのが枠換算の物差しで、割る相手が0のときに`Infinity`を画面へ出さないこと。
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
      quotaByAgent: { claude: null, codex: null },
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
      quotaByAgent: { claude: null, codex: null },
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
      quotaByAgent: { claude: null, codex: null },
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
      quotaByAgent: { claude: null, codex: null },
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
      quotaByAgent: { claude: null, codex: null },
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
      quotaByAgent: { claude: null, codex: null },
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
      quotaByAgent: { claude: null, codex: null },
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
      quotaByAgent: { claude: null, codex: null },
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
      quotaByAgent: { claude: null, codex: null },
    });

    expect(summary.byRepository.map((row) => row.key)).toEqual(["dayspan", "", "issue-deck"]);
    expect(summary.byKind.map((row) => row.key)).toEqual(["implementation", "other"]);
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
      quotaByAgent: { claude: null, codex: null },
    });

    expect(summary.totalsByAgent.claude.costUsd).toBe(3);
    expect(summary.totalsByAgent.codex.costUsd).toBe(2);
    expect(summary.byDay[0].byAgent.codex.sessions).toBe(1);
    expect(summary.byRepository[0].byAgent.claude.sessions).toBe(1);
    expect(summary.byKind[0].byAgent.codex.sessions).toBe(1);
  });
});

describe("buildQuotaScale", () => {
  const windows = [
    { key: "5h", label: "5時間", usedPercent: 50, resetsAt: (NOW_MS + 3_600_000) / 1000, durationMs: 5 * 3_600_000 },
    { key: "7d", label: "週間", usedPercent: 20, resetsAt: (NOW_MS + 86_400_000) / 1000, durationMs: 7 * 86_400_000 },
  ];

  it("長いほうの窓で「1%あたり何ドルぶんか」を逆算する", () => {
    const scale = buildQuotaScale({
      windows,
      entries: [entry({ costUsd: 40, endedAt: "2026-08-30T02:00:00.000Z" })],
      nowMs: NOW_MS,
    });

    expect(scale?.windowKey).toBe("7d");
    // 週間枠20%で$40使っていれば、1%あたり$2。
    expect(scale?.usdPerPercent).toBeCloseTo(2, 6);
    expect(toQuotaPercent(10, scale)).toBeCloseTo(5, 6);
  });

  it("窓の外の消費は物差しに入れない", () => {
    const scale = buildQuotaScale({
      windows,
      entries: [
        entry({ sessionId: "in", costUsd: 40, endedAt: "2026-08-30T02:00:00.000Z" }),
        entry({ sessionId: "old", costUsd: 999, endedAt: "2026-07-01T00:00:00.000Z" }),
      ],
      nowMs: NOW_MS,
    });

    expect(scale?.windowCostUsd).toBe(40);
  });

  it("使用率が0%・消費が無い・リセット時刻が取れない窓では物差しを作らない", () => {
    expect(
      buildQuotaScale({
        windows: [{ ...windows[1], usedPercent: 0 }],
        entries: [entry({ costUsd: 40 })],
        nowMs: NOW_MS,
      }),
    ).toBeNull();

    expect(
      buildQuotaScale({ windows: [windows[1]], entries: [], nowMs: NOW_MS }),
    ).toBeNull();

    expect(
      buildQuotaScale({
        windows: [{ ...windows[1], resetsAt: null }],
        entries: [entry({ costUsd: 40 })],
        nowMs: NOW_MS,
      }),
    ).toBeNull();
  });

  it("リセット時刻が過去（取得が古い）窓は使わない", () => {
    const stale = { ...windows[1], resetsAt: (NOW_MS - 86_400_000) / 1000 };
    expect(
      buildQuotaScale({ windows: [stale], entries: [entry({ costUsd: 40 })], nowMs: NOW_MS }),
    ).toBeNull();
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

  it("枠換算は1%未満でも0%と区別できるように出す", () => {
    expect(formatQuotaPercent(23.4)).toBe("23%");
    expect(formatQuotaPercent(2.34)).toBe("2.3%");
    expect(formatQuotaPercent(0.234)).toBe("0.23%");
    expect(formatQuotaPercent(0.0001)).toBe("0.01%");
  });

  it("トークン数は単位で畳む", () => {
    expect(formatUsageTokens(12_852_563_529)).toBe("12.85G");
    expect(formatUsageTokens(116_593_336)).toBe("117M");
    expect(formatUsageTokens(39_198)).toBe("39k");
  });

  it("物差しが無ければ「枠%」を選んでいてもドルで出す", () => {
    expect(formatUsageAmount(12.5, "quota", null)).toBe("$12.50");
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
