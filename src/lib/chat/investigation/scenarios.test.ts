import { beforeEach, describe, expect, it, vi } from "vitest";

const findRepositoryByFullName = vi.fn();
const fetchPullRequest = vi.fn();
const issueFindMany = vi.fn();

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "tok") }));
vi.mock("@/lib/db", () => ({ db: { issue: { findMany: (...a: unknown[]) => issueFindMany(...a) } } }));
vi.mock("@/lib/github/issue-create-service", () => ({
  findRepositoryByFullName: (...a: unknown[]) => findRepositoryByFullName(...a),
}));
vi.mock("@/lib/github/pull-requests-api", () => ({
  fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a),
}));
vi.mock("@/lib/chat/fix-progress-loader", () => ({
  latestFixRequest: vi.fn(() => null),
  loadFixProgress: vi.fn(),
}));

import type { CallModel } from "@/lib/chat/investigation/agent";
import { replyWithInvestigation } from "@/lib/chat/investigation/reply";
import { EMPTY_CHAT_CONTEXT, type ChatContext } from "@/lib/chat/types";

const final = (extra: Record<string, unknown>) =>
  JSON.stringify({
    action: "final",
    tool: "",
    args_json: "",
    reply: "調べました。",
    facts: ["f"],
    inferences: [],
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
const tool = JSON.stringify({ action: "tool", tool: "get_pull_request", args_json: '{"number":12}' });

function model(...texts: string[]): CallModel {
  let i = 0;
  return async () => ({ ok: true, text: texts[Math.min(i++, texts.length - 1)] });
}
const toolOk = async () => ({
  ok: true,
  text: "PR",
  evidence: [{ label: "PR #12", url: "https://github.com/a/b/pull/12", fetchedAt: "2026-10-05T00:00:00Z", ref: "HEAD abc1234" }],
});

const ctx: ChatContext = { ...EMPTY_CHAT_CONTEXT, repo: "a/b" };
const run = (text: string, over: Partial<Parameters<typeof replyWithInvestigation>[0]> = {}) =>
  replyWithInvestigation({
    user: { id: "u" },
    context: ctx,
    text,
    target: { repo: "a/b", number: 12 },
    candidates: [],
    history: [],
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  findRepositoryByFullName.mockResolvedValue({ id: "r1", installation: { installationId: 1 } });
  issueFindMany.mockResolvedValue([]);
  fetchPullRequest.mockResolvedValue({
    state: "open",
    merged: false,
    title: "PR12",
    head: { ref: "issue-100", sha: "abc1234ffff" },
  });
});

describe("会話シナリオ", () => {
  it("「なぜ止まっている？」は調査して根拠つきで答え、確認カードは出さない（書き込みなし）", async () => {
    const reply = await run("#12はなぜ止まっている？", {
      deps: {
        callModel: model(tool, final({ proposal_kind: "fix_request", proposal_number: 12, proposal_body: "直す" })),
        tool: toolOk,
      },
    });
    expect(reply.needsConfirm).toBe(false);
    expect(reply.cards.map((c) => c.type)).toEqual(["investigation"]);
    expect(reply.nextContext.investigation?.target?.number).toBe(12);
    expect(reply.nextContext.investigation?.evidence[0].ref).toBe("HEAD abc1234");
  });

  it("「確認して直して」は調査後に、最新HEAD・合意方針つきの修正依頼カードを出す", async () => {
    const reply = await run("#12を確認して直して", {
      deps: {
        callModel: model(
          tool,
          final({
            proposal_kind: "fix_request",
            proposal_number: 12,
            proposal_repo: "a/b",
            proposal_body: "指摘1を直す。検証: pnpm test",
            agreements: ["指摘1だけ直す"],
          }),
        ),
        tool: toolOk,
      },
    });
    const card = reply.cards.find((c) => c.type === "confirm_fix_request");
    expect(reply.needsConfirm).toBe(true);
    expect(card).toMatchObject({ number: 12, issueNumber: 100, headSha: "abc1234ffff" });
    expect(card && "instruction" in card && card.instruction).toContain("指摘1だけ直す");
  });

  it("調査後にHEADが進んでいたら依頼カードを作らない", async () => {
    fetchPullRequest.mockResolvedValue({ state: "open", merged: false, title: "x", head: { ref: "issue-100", sha: "9999999aaaa" } });
    const reply = await run("確認して直して", {
      deps: {
        callModel: model(tool, final({ proposal_kind: "fix_request", proposal_number: 12, proposal_repo: "a/b", proposal_body: "直す" })),
        tool: toolOk,
      },
    });
    expect(reply.needsConfirm).toBe(false);
    expect(reply.text).toContain("HEADが進みました");
  });

  it("issue-<番号>でないブランチは、依頼先が無いと理由を返す", async () => {
    fetchPullRequest.mockResolvedValue({ state: "open", merged: false, title: "x", head: { ref: "feature/x", sha: "abc1234ffff" } });
    const reply = await run("確認して直して", {
      deps: {
        callModel: model(tool, final({ proposal_kind: "fix_request", proposal_number: 12, proposal_repo: "a/b", proposal_body: "直す" })),
        tool: toolOk,
      },
    });
    expect(reply.cards.some((c) => c.type === "confirm_fix_request")).toBe(false);
    expect(reply.text).toContain("issue-<番号>");
  });

  it("「その方針でIssueにして」は整理したIssue案に重複候補と根拠を添える", async () => {
    issueFindMany.mockResolvedValue([{ number: 5, title: "チャット調査", htmlUrl: "https://x/5", state: "OPEN" }]);
    const reply = await run("その方針でIssueにして", {
      context: {
        ...ctx,
        investigation: {
          target: null,
          summary: "調査",
          evidence: [],
          agreements: ["読み取りのみ"],
          openQuestions: [],
          unconfirmed: [],
          updatedAt: "",
        },
      },
      deps: {
        callModel: model(
          tool,
          final({ proposal_kind: "issue", proposal_repo: "a/b", proposal_title: "チャット調査を拡張", proposal_body: "## 目的\n…\n## 完了条件\n- [ ] x", agreements: ["書き込みは確認カード"] }),
        ),
        tool: toolOk,
      },
    });
    const card = reply.cards.find((c) => c.type === "confirm_issue");
    expect(card && "duplicates" in card && card.duplicates).toHaveLength(1);
    expect(card && "body" in card && card.body).toContain("## 根拠");
    // 合意は引き継がれ、新しい合意が足される
    expect(reply.nextContext.investigation?.agreements).toEqual(["読み取りのみ", "書き込みは確認カード"]);
  });

  it("方針の質問に答えると、元の対象・調査・未解決を保持して再開する", async () => {
    const first = await run("#12はなぜ止まっている？", {
      deps: {
        callModel: model(final({ open_questions: ["認証方式を変えますか？"], reply: "判断が要ります" })),
      },
    });
    expect(first.nextContext.investigation?.openQuestions).toEqual(["認証方式を変えますか？"]);
    let prompt = "";
    const second = await run("変えない。続けて", {
      target: null,
      context: first.nextContext,
      deps: {
        callModel: async ({ messages }) => {
          prompt = messages[messages.length - 1].content;
          return { ok: true, text: final({ reply: "続けます", agreements: ["認証方式は変えない"] }) };
        },
      },
    });
    expect(prompt).toContain("認証方式を変えますか？");
    expect(prompt).toContain("a/b#12");
    expect(second.nextContext.investigation?.agreements).toContain("認証方式は変えない");
    expect(second.nextContext.investigation?.target?.number).toBe(12);
  });

  it("上限・失敗で止まったら、途中結果と停止理由・次の行動を返す（問題なしとは言わない）", async () => {
    const failing = async () => ({ ok: false, text: "403", evidence: [] });
    const reply = await run("なぜ？", {
      deps: {
        callModel: model(
          JSON.stringify({ action: "tool", tool: "get_pull_request", args_json: '{"number":12}' }),
          JSON.stringify({ action: "tool", tool: "get_pr_discussion", args_json: '{"number":12}' }),
          JSON.stringify({ action: "tool", tool: "get_ci_failure_log", args_json: '{"number":12}' }),
        ),
        tool: failing,
      },
    });
    expect(reply.text).toContain("途中で止めました");
    expect(reply.text).toContain("次の行動");
    expect(reply.text).not.toContain("問題はありません");
    const card = reply.cards.find((c) => c.type === "investigation");
    expect(card && "stopReason" in card && card.stopReason).toBeTruthy();
  });

  it("AIが使えないときは調査に入れなかったと返し、定型応答へ戻せる", async () => {
    const reply = await run("なぜ？", {
      deps: { callModel: async () => ({ ok: false, reason: "AIの認証情報が設定されていません" }) },
    });
    expect(reply.unavailable).toBe(true);
    expect(reply.needsConfirm).toBe(false);
  });

  it("番号のない相談は、PR番号を求めずツールなしで案を返し、提案カードを出さない（#4093）", async () => {
    const reply = await run("勤務画面を週ごとに表示したいかも", {
      target: null,
      model: undefined,
      deps: { callModel: model(final({ reply: "案A: 週表示 / 案B: 週月切替（推奨）", proposal_kind: "issue", proposal_repo: "a/b", proposal_title: "t", proposal_body: "b" })) },
    } as never);
    expect(reply.unavailable).toBe(false);
    expect(reply.text).toContain("週月切替");
    expect(reply.needsConfirm).toBe(false);
    expect(reply.cards.some((c) => c.type.startsWith("confirm_"))).toBe(false);
    expect(reply.nextContext.targets).toEqual([]);
  });

  it("起案依頼では、相談の合意を反映したIssue案を確認カードで返す（#4093）", async () => {
    const reply = await run("この内容でIssue起案して", {
      target: null,
      deps: { callModel: model(final({ agreements: ["週/月の切替"], proposal_kind: "issue", proposal_repo: "a/b", proposal_title: "勤務画面の週表示", proposal_body: "## 合意\n- 週/月の切替" })) },
    } as never);
    expect(reply.needsConfirm).toBe(true);
    expect(reply.cards.find((c) => c.type === "confirm_issue")).toMatchObject({ title: "勤務画面の週表示" });
    expect(reply.nextContext.investigation?.agreements).toEqual(["週/月の切替"]);
  });

  it.each([
    ["AIの認証情報が設定されていません", "認証情報が未設定"],
    ["HTTP 401", "認証が拒否"],
    ["時間切れ", "通信に失敗"],
    ["応答が空でした", "読み取れませんでした"],
  ])("AIが使えないとき、原因（%s）と再試行を出し、操作案内で上書きしない", async (reason, label) => {
    const reply = await run("勤務画面を週ごとに表示したいかも", {
      target: null,
      deps: { callModel: async () => ({ ok: false, reason }) },
    } as never);
    expect(reply.unavailable).toBe(true);
    expect(reply.text).toContain(label);
    expect(reply.text).not.toContain("次のように話しかけてください");
    expect(reply.cards).toContainEqual(expect.objectContaining({ type: "choice", options: [{ label: "同じ内容で再試行", send: "勤務画面を週ごとに表示したいかも" }] }));
  });
});
