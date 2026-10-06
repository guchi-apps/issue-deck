import { describe, expect, it } from "vitest";

import {
  applyMemoryOp,
  buildRefsText,
  diffRows,
  parseChatMemory,
  parseSearchQuery,
  recordFindings,
} from "@/lib/chat/session";
import type { ChatStatusCard } from "@/lib/chat/types";
import { EMPTY_CHAT_MEMORY } from "@/lib/chat/types";

const NOW = new Date("2026-10-05T00:00:00Z");

function card(number: number, ci: string): ChatStatusCard {
  return {
    type: "status",
    repo: "o/r",
    number,
    kind: "pr",
    title: `PR ${number}`,
    htmlUrl: null,
    rows: [{ label: "CI", value: ci, tone: "ok" }],
    relatedIssue: null,
    repairKinds: [],
    session: null,
  };
}

describe("applyMemoryOp", () => {
  it("合意を追加・削除でき、空文字や存在しないIDは拒否する", () => {
    const added = applyMemoryOp(EMPTY_CHAT_MEMORY, { op: "add", kind: "agreement", text: " 方針A " }, NOW, () => "m1");
    expect(added?.agreements).toEqual([{ id: "m1", text: "方針A", createdAt: NOW.toISOString() }]);
    expect(applyMemoryOp(EMPTY_CHAT_MEMORY, { op: "add", kind: "agreement", text: "  " }, NOW, () => "x")).toBeNull();
    expect(applyMemoryOp(added!, { op: "remove", kind: "agreement", id: "nope" }, NOW, () => "x")).toBeNull();
    expect(applyMemoryOp(added!, { op: "remove", kind: "agreement", id: "m1" }, NOW, () => "x")?.agreements).toEqual([]);
  });

  it("未解決の質問を解決済みにする", () => {
    const added = applyMemoryOp(EMPTY_CHAT_MEMORY, { op: "add", kind: "openQuestion", text: "Q" }, NOW, () => "q1")!;
    const resolved = applyMemoryOp(added, { op: "resolve", id: "q1" }, NOW, () => "x")!;
    expect(resolved.openQuestions[0].resolvedAt).toBe(NOW.toISOString());
  });
});

describe("recordFindings / diffRows", () => {
  it("同じ対象は最新で置き換え、調査時点との差を行ごとに返す", () => {
    const first = recordFindings(EMPTY_CHAT_MEMORY, [card(1, "成功"), card(2, "成功")], NOW);
    const second = recordFindings(first, [card(1, "失敗")], NOW);
    expect(second.findings.map((f) => `${f.number}:${f.rows[0].value}`)).toEqual(["2:成功", "1:失敗"]);
    expect(diffRows(first.findings[0].rows, [{ label: "CI", value: "失敗", tone: "bad" }])).toEqual([
      { label: "CI", before: "成功", after: "失敗" },
    ]);
  });
});

describe("parseChatMemory", () => {
  it("壊れた値でも空のメモに落とす", () => {
    expect(parseChatMemory(null)).toEqual(EMPTY_CHAT_MEMORY);
    expect(parseChatMemory({ agreements: [{ id: 1 }, { id: "a", text: "t" }] }).agreements).toHaveLength(1);
  });
});

describe("buildRefsText / parseSearchQuery", () => {
  it("対象と発言中の番号を検索用に連結し、重複しない", () => {
    const text = buildRefsText(
      { repo: "o/r", targets: [{ repo: "o/r", number: 3966, kind: "pr", title: "" }], actions: [] },
      ["4047を見て", "#3966 も"],
      "",
    );
    expect(text).toBe("o/r#3966 o/r#4047 ");
  });

  it("番号検索と本文検索を分ける", () => {
    expect(parseSearchQuery("#3966")).toEqual({ text: "#3966", number: 3966 });
    expect(parseSearchQuery(" 3966 ")).toEqual({ text: "3966", number: 3966 });
    expect(parseSearchQuery("CI失敗")).toEqual({ text: "CI失敗", number: null });
  });
});
