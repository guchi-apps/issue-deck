import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));


import {
  callKey,
  INVESTIGATION_LIMITS,
  parseStep,
  runInvestigation,
  type CallModel,
} from "@/lib/chat/investigation/agent";
import type { ToolResult } from "@/lib/chat/investigation/tools";

const finalStep = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: "final",
    tool: "",
    args_json: "",
    reply: "レビューは古いHEADへの判定で、未解消の指摘が1件あります。",
    facts: ["HEAD abc1234 のCIは成功"],
    inferences: ["指摘は修正可能"],
    unconfirmed: [],
    agreements: [],
    open_questions: [],
    proposal_kind: "none",
    proposal_repo: "",
    proposal_number: 0,
    proposal_title: "",
    proposal_body: "",
    ...extra,
  });

const toolStep = (tool: string, args: Record<string, unknown>) =>
  JSON.stringify({ action: "tool", tool, args_json: JSON.stringify(args) });

function scripted(texts: string[]): { callModel: CallModel; calls: number } {
  const state = { calls: 0 };
  const callModel: CallModel = async () => {
    const text = texts[Math.min(state.calls, texts.length - 1)];
    state.calls++;
    return { ok: true, text };
  };
  return { callModel, get calls() { return state.calls; } } as { callModel: CallModel; calls: number };
}

const ok = (text: string): ToolResult => ({
  ok: true,
  text,
  evidence: [{ label: "PR", url: "https://github.com/a/b/pull/1", fetchedAt: "2026-10-05T00:00:00Z", ref: "HEAD abc1234" }],
});

const base = {
  ctx: { user: { id: "u" }, defaultRepo: "a/b", now: () => new Date("2026-10-05T00:00:00Z") },
  userText: "なぜ止まっている？",
  history: [],
  investigation: null,
  targetHint: "a/b#1",
};

describe("runInvestigation", () => {
  it("結果を見て追加調査し、集めた根拠つきで最終回答を返す", async () => {
    const model = scripted([
      toolStep("get_pull_request", { number: 1 }),
      toolStep("get_pr_discussion", { number: 1 }),
      finalStep(),
    ]);
    const tool = vi.fn(async (_c, name: string) => ok(`result of ${name}`));
    const result = await runInvestigation({ ...base, callModel: model.callModel, tool });
    expect(tool).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBeNull();
    expect(result.reply).toContain("未解消");
    expect(result.evidence).toHaveLength(1); // 同じ根拠は重複させない
    expect(result.toolCalls.map((c) => c.name)).toEqual(["get_pull_request", "get_pr_discussion"]);
  });

  it("同じ呼び出しの繰り返しは進展なしとして止め、途中結果を返す", async () => {
    const model = scripted([toolStep("get_pull_request", { number: 1 })]);
    const tool = vi.fn(async () => ok("x"));
    const result = await runInvestigation({ ...base, callModel: model.callModel, tool });
    expect(tool).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toContain("進展なし");
    expect(result.evidence).toHaveLength(1);
  });

  it("取得失敗が続いたら止める（失敗を問題なしにしない）", async () => {
    const model = scripted([
      toolStep("get_pull_request", { number: 1 }),
      toolStep("get_pr_discussion", { number: 1 }),
      toolStep("get_ci_failure_log", { number: 1 }),
      finalStep(),
    ]);
    const tool = vi.fn(async (): Promise<ToolResult> => ({ ok: false, text: "403", evidence: [] }));
    const result = await runInvestigation({ ...base, callModel: model.callModel, tool });
    expect(result.stopReason).toContain("失敗が続いた");
    expect(result.reply).toBe("");
    expect(result.toolCalls.every((c) => !c.ok)).toBe(true);
  });

  it("回数の上限では、最後のステップでツールを使わず最終回答を求める", async () => {
    let n = 0;
    const seenLast: string[] = [];
    const callModel: CallModel = async ({ messages }) => {
      n++;
      if (n === INVESTIGATION_LIMITS.maxSteps) seenLast.push(messages[messages.length - 1].content);
      return { ok: true, text: n < INVESTIGATION_LIMITS.maxSteps ? toolStep("search_issues", { query: `q${n}` }) : finalStep() };
    };
    const tool = vi.fn(async () => ok("x"));
    const result = await runInvestigation({ ...base, callModel, tool });
    expect(n).toBe(INVESTIGATION_LIMITS.maxSteps);
    expect(seenLast[0]).toContain("上限");
    expect(result.stopReason).toBeNull();
  });

  it("時間の上限に達したら途中で止める", async () => {
    let now = 0;
    const callModel: CallModel = async () => {
      now += INVESTIGATION_LIMITS.maxDurationMs + 1;
      return { ok: true, text: toolStep("search_issues", { query: "a" }) };
    };
    const result = await runInvestigation({ ...base, callModel, tool: async () => ok("x"), clock: () => now });
    expect(result.stopReason).toContain("時間の上限");
  });

  it("未知のツールは実行せず、AIの失敗は停止理由として返す", async () => {
    const tool = vi.fn(async () => ok("x"));
    const bad = scripted([toolStep("rm_rf", {}), finalStep()]);
    const result = await runInvestigation({ ...base, callModel: bad.callModel, tool });
    expect(tool).not.toHaveBeenCalled();
    expect(result.reply).toContain("未解消");

    const down: CallModel = async () => ({ ok: false, reason: "HTTP 529" });
    const failed = await runInvestigation({ ...base, callModel: down, tool });
    expect(failed.stopReason).toContain("HTTP 529");
    expect(failed.steps).toBe(0);
  });

  it("取得結果の機密値は伏せてモデルへ渡す", async () => {
    const seen: string[] = [];
    let n = 0;
    const callModel: CallModel = async ({ messages }) => {
      seen.push(messages[messages.length - 1].content);
      return { ok: true, text: n++ === 0 ? toolStep("get_issue", { number: 1 }) : finalStep() };
    };
    await runInvestigation({ ...base, callModel, tool: async () => ok("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 を使う") });
    expect(seen[1]).toContain("[伏せ字]");
    expect(seen[1]).not.toContain("ghp_abcdef");
  });

  it("直前の調査の引き継ぎ（対象・合意・未解決）を最初の依頼へ載せる", async () => {
    const seen: string[] = [];
    const callModel: CallModel = async ({ messages }) => {
      seen.push(messages[messages.length - 1].content);
      return { ok: true, text: finalStep() };
    };
    await runInvestigation({
      ...base,
      callModel,
      userText: "この方針で続けて",
      investigation: {
        target: { repo: "a/b", number: 1, kind: "pr", title: "t" },
        summary: "指摘は1件",
        evidence: [],
        agreements: ["テストを足す"],
        openQuestions: ["認証方式はどうする？"],
        unconfirmed: [],
        updatedAt: "2026-10-05T00:00:00Z",
      },
    });
    expect(seen[0]).toContain("a/b#1");
    expect(seen[0]).toContain("テストを足す");
    expect(seen[0]).toContain("認証方式はどうする？");
  });
});

describe("parseStep / callKey", () => {
  it("提案の種類は既知の値だけを通す", () => {
    const step = parseStep(finalStep({ proposal_kind: "delete_repo" }));
    expect(step?.final?.proposal.kind).toBe("none");
    expect(parseStep("not json")).toBeNull();
  });
  it("引数の並び順が違っても同じ呼び出しとみなす", () => {
    expect(callKey("a", { x: 1, y: 2 })).toBe(callKey("a", { y: 2, x: 1 }));
  });
});
