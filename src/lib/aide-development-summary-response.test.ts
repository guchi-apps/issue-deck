import { describe, expect, it } from "vitest";

import type { DevelopmentSummary, SummaryItem } from "@/lib/aide-development-summary";
import {
  buildSummaryResponse,
  decodeCursor,
  encodeCursor,
  paginate,
  parseInstant,
  parseSummaryQuery,
  selectAttentionItems,
} from "@/lib/aide-development-summary-response";
import type { SummarySourceStatus } from "@/lib/aide-development-summary-load";

const NOW = new Date("2026-10-05T03:00:00.000Z");

type Body = {
  attention: { total: number; items: unknown[]; truncated: boolean; nextCursor: string | null };
  totals: unknown;
  byRepository: Record<string, unknown>;
  category: string;
  total: number;
  items: unknown[];
  truncated: boolean;
};

describe("parseSummaryQuery", () => {
  it("期間を省略すると直近7日で、実際の範囲とタイムゾーンの既定を使う", () => {
    const parsed = parseSummaryQuery(new URLSearchParams(), NOW);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.query.to.toISOString()).toBe(NOW.toISOString());
    expect(parsed.query.from.toISOString()).toBe("2026-09-28T03:00:00.000Z");
    expect(parsed.query.timezone).toBe("Asia/Tokyo");
    expect(parsed.query.attentionLimit).toBe(10);
  });

  it("日付だけの指定はタイムゾーンのその日の0時になる", () => {
    expect(parseInstant("2026-10-05", "Asia/Tokyo")?.toISOString()).toBe("2026-10-04T15:00:00.000Z");
    expect(parseInstant("2026-10-05", "UTC")?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(parseInstant("2026-03-08", "America/New_York")?.toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("オフセットの無い日時・不正な値・逆転した期間・長すぎる期間を弾く", () => {
    const err = (query: string) => {
      const parsed = parseSummaryQuery(new URLSearchParams(query), NOW);
      return parsed.ok ? null : parsed.error;
    };

    expect(err("from=2026-10-01T00:00:00")).toBe("invalid_from");
    expect(err("to=abc")).toBe("invalid_to");
    expect(err("from=2026-10-05&to=2026-10-01")).toBe("invalid_period");
    expect(err("from=2026-01-01&to=2026-10-01")).toBe("period_too_long");
    expect(err("timezone=Mars/Base")).toBe("invalid_timezone");
    expect(err("category=bogus")).toBe("invalid_category");
    expect(err("repositoryFullName=../x")).toBe("invalid_repository");
    expect(err("limit=0")).toBe("invalid_limit");
    expect(err("cursor=zzz")).toBe("invalid_cursor");
  });
});

describe("paginate", () => {
  it("総件数は全件の長さで、先頭ページの件数ではない。cursorで続きを引ける", () => {
    const all = Array.from({ length: 25 }, (_, i) => i);
    const first = paginate(all, 0, 10);

    expect(first.total).toBe(25);
    expect(first.items).toHaveLength(10);
    expect(first.truncated).toBe(true);
    const offset = decodeCursor(first.nextCursor as string);
    expect(offset).toBe(10);
    const last = paginate(all, 20, 10);
    expect(last.items).toEqual([20, 21, 22, 23, 24]);
    expect(last.truncated).toBe(false);
    expect(last.nextCursor).toBeNull();
    expect(decodeCursor(encodeCursor(7))).toBe(7);
  });
});

function item(overrides: Partial<SummaryItem>): SummaryItem {
  return {
    kind: "issue",
    id: "issue:o/a#1",
    category: "checkUser",
    repositoryFullName: "o/a",
    owner: "o",
    repo: "a",
    number: 1,
    title: "t",
    url: "u",
    reasonCode: "plan",
    reason: "r",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function summaryWith(items: Partial<DevelopmentSummary["items"]>): DevelopmentSummary {
  const empty = {
    notStarted: [],
    inProgress: [],
    reserved: [],
    checkUser: [],
    manualStep: [],
    problems: [],
    pullRequests: [],
    deployment: [],
    recentCompletions: [],
  };
  return {
    population: { repositories: 2, excludedArchived: [], excludedHidden: [], issues: 0, snoozedIssues: 0 },
    totals: { marker: "totals" },
    byRepository: { "o/a": { marker: "a" }, "o/b": { marker: "b" } },
    items: { ...empty, ...items },
    reservation: {},
    problems: { currentTotal: 0 },
    pullRequestsAvailable: true,
    recentCompletions: { from: "f", to: "t", historyComplete: true, historyNote: null },
    overlapNotes: [],
    warnings: [],
  } as unknown as DevelopmentSummary;
}

const SOURCE: SummarySourceStatus = {
  generatedAt: NOW.toISOString(),
  sourceUpdatedAt: null,
  stale: true,
  staleRepositories: ["o/a"],
  unavailable: ["deployEvidence"],
  complete: false,
};

describe("要対応の上位項目", () => {
  const items = {
    checkUser: [
      item({ id: "issue:o/a#1", number: 1 }),
      item({ id: "issue:o/a#2", number: 2, reasonCode: "agent-running" }),
    ],
    manualStep: [item({ id: "issue:o/b#3", category: "manualStep", repositoryFullName: "o/b", reasonCode: "waiting-prerequisites" })],
    pullRequests: [item({ kind: "pr", id: "pr:o/a#9", category: "pullRequests", reasonCode: "ci-failed" }), item({ kind: "pr", id: "pr:o/a#8", category: "pullRequests", reasonCode: "draft" })],
  };

  it("稼働中・前提待ち・draftは要対応に含めない", () => {
    const ids = selectAttentionItems(summaryWith(items), null).map((i) => i.id).sort();

    expect(ids).toEqual(["issue:o/a#1", "pr:o/a#9"]);
  });

  it("上位N件で切っても全件数とtruncated・nextCursorを返し、鮮度・不明を含める", () => {
    const query = parseSummaryQuery(new URLSearchParams("attentionLimit=1"), NOW);
    if (!query.ok) throw new Error("parse");
    const body = buildSummaryResponse(summaryWith(items), SOURCE, query.query, "me") as unknown as Body;

    expect(body.attention.total).toBe(2);
    expect(body.attention.items).toHaveLength(1);
    expect(body.attention.truncated).toBe(true);
    expect(body.attention.nextCursor).not.toBeNull();
    expect(body).toMatchObject({ schemaVersion: 1, stale: true, complete: false, unavailable: ["deployEvidence"] });
    expect(body.totals).toEqual({ marker: "totals" });
  });

  it("repositoryFullNameで内訳を絞り、母集団に無いリポジトリはnull", () => {
    const parse = (q: string) => {
      const p = parseSummaryQuery(new URLSearchParams(q), NOW);
      if (!p.ok) throw new Error("parse");
      return p.query;
    };
    const body = buildSummaryResponse(summaryWith(items), SOURCE, parse("repositoryFullName=o/b"), "me") as unknown as Body;

    expect(body.totals).toEqual({ marker: "b" });
    expect(Object.keys(body.byRepository)).toEqual(["o/b"]);
    expect(buildSummaryResponse(summaryWith(items), SOURCE, parse("repositoryFullName=o/zzz"), "me")).toBeNull();
  });

  it("categoryを指定すると詳細一覧を返す（稼働中も含めた全件）", () => {
    const p = parseSummaryQuery(new URLSearchParams("category=checkUser&limit=1"), NOW);
    if (!p.ok) throw new Error("parse");
    const body = buildSummaryResponse(summaryWith(items), SOURCE, p.query, "me") as unknown as Body;

    expect(body.category).toBe("checkUser");
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });
});
