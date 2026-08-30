import { describe, expect, it } from "vitest";

import {
  parseSessionUsagePayload,
  parseSessionUsageReport,
} from "@/lib/dispatch/session-usage";

/**
 * トークン使用量の報告（#2504）の受け取り。
 *
 * **ここの要点は「壊れた行を捨てて残りを受け入れる」こと。** `DispatchSession`の報告
 * （`session-state.ts`）は1件でも壊れていたら全体を拒否するが、あちらは落とすと「消えた」と
 * 判定されてしまうためで、こちらは落としても次の報告で入り直す。転記の形はClaude Codeの
 * 内部仕様なので、想定外が1件混ざっただけでその日の数字が丸ごと欠けるほうが損になる。
 */

function reportInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "abc-123",
    transcript: "/home/u/.claude/projects/-slug/abc-123.jsonl",
    kind: "implementation",
    repository: "issue-deck",
    issue: 2504,
    responses: 10,
    input: 100,
    cacheCreate5m: 200,
    cacheCreate1h: 300,
    cacheRead: 400,
    output: 50,
    costUsd: 1.25,
    models: ["claude-opus-5"],
    startedAt: "2026-08-30T01:00:00.000Z",
    endedAt: "2026-08-30T02:00:00.000Z",
    ...overrides,
  };
}

describe("parseSessionUsageReport", () => {
  it("シェルが送る形をそのまま受け取れる", () => {
    const parsed = parseSessionUsageReport(reportInput());
    expect(parsed).toMatchObject({
      agent: "claude",
      sessionId: "abc-123",
      kind: "implementation",
      repository: "issue-deck",
      issueNumber: 2504,
      responses: 10,
      cacheCreate1hTokens: 300,
      costUsd: 1.25,
    });
    expect(parsed?.startedAt.toISOString()).toBe("2026-08-30T01:00:00.000Z");
  });

  it("Codexの報告を区別し、未知のエージェントは捨てる", () => {
    expect(parseSessionUsageReport(reportInput({ agent: "codex" }))?.agent).toBe("codex");
    expect(parseSessionUsageReport(reportInput({ agent: "other" }))).toBeNull();
  });

  it("Issue番号・リポジトリを持たないセッション（計画レビュー・横断質問）も受け取る", () => {
    const parsed = parseSessionUsageReport(
      reportInput({ kind: "question", repository: null, issue: null }),
    );
    expect(parsed?.repository).toBeNull();
    expect(parsed?.issueNumber).toBeNull();
  });

  it.each([
    ["セッションIDが空", { sessionId: "" }],
    ["知らない種別", { kind: "unknown-kind" }],
    ["トークン数が負", { cacheRead: -1 }],
    ["金額が数値でない", { costUsd: "1.25" }],
    ["時刻が壊れている", { endedAt: "きのう" }],
    ["モデルが文字列の配列でない", { models: [1] }],
    ["応答が0（数える意味が無い）", { responses: 0 }],
  ])("%s 行は受け取らない", (_label, overrides) => {
    expect(parseSessionUsageReport(reportInput(overrides))).toBeNull();
  });
});

describe("parseSessionUsagePayload", () => {
  it("壊れた行だけを捨て、読めた行は受け入れる", () => {
    const parsed = parseSessionUsagePayload({
      host: "subpc",
      reportedAt: "2026-08-30T03:00:00.000Z",
      sessions: [reportInput(), reportInput({ kind: "壊れている" })],
    });

    expect(parsed?.sessions).toHaveLength(1);
    expect(parsed?.skipped).toBe(1);
    expect(parsed?.reportedAt.toISOString()).toBe("2026-08-30T03:00:00.000Z");
  });

  it("sessionsが配列でない本文は受け取らない", () => {
    expect(parseSessionUsagePayload({ host: "subpc", sessions: null })).toBeNull();
    expect(parseSessionUsagePayload(null)).toBeNull();
  });

  it("1回で受け取る件数には上限がある（pollerは分けて送る）", () => {
    const sessions = Array.from({ length: 501 }, (_unused, index) =>
      reportInput({ sessionId: `id-${index}` }),
    );
    expect(parseSessionUsagePayload({ host: "subpc", sessions })).toBeNull();
  });

  it("報告時刻が無ければ受け取った時刻で埋める", () => {
    const before = Date.now();
    const parsed = parseSessionUsagePayload({ host: "subpc", sessions: [] });
    expect(parsed?.reportedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
