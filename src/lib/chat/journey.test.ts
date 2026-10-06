import { beforeEach, describe, expect, it, vi } from "vitest";

const findRepositoryByFullName = vi.fn();
const fetchPullRequest = vi.fn();

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "tok") }));
vi.mock("@/lib/db", () => ({ db: { issue: { findMany: vi.fn(async () => []) } } }));
vi.mock("@/lib/github/issue-create-service", () => ({
  findRepositoryByFullName: (...a: unknown[]) => findRepositoryByFullName(...a),
}));
vi.mock("@/lib/github/pull-requests-api", () => ({
  fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a),
}));
vi.mock("@/lib/github/pull-request-repair-service", () => ({ planPullRequestRepair: vi.fn() }));
vi.mock("@/lib/chat/handlers", () => ({
  loadStatus: vi.fn(async () => ({ ok: false, message: "未取得" })),
  withAction: (c: unknown) => c,
}));
vi.mock("@/lib/chat/fix-progress-loader", () => ({
  latestFixRequest: vi.fn(() => null),
  loadFixProgress: vi.fn(),
}));

import type { CallModel } from "@/lib/chat/investigation/agent";
import { replyWithInvestigation } from "@/lib/chat/investigation/reply";
import { refreshConversation } from "@/lib/chat/resume";
import { parseChatContext } from "@/lib/chat/store";
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
const model =
  (...texts: string[]): CallModel =>
  async () => ({ ok: true, text: texts.shift() ?? texts[0] ?? "" });

/** 保存（DB）を経由して別端末で開き直した状態を再現する */
const reopen = (context: ChatContext): ChatContext => parseChatContext(JSON.parse(JSON.stringify(context)));

const turn = (context: ChatContext, text: string, callModel: CallModel) =>
  replyWithInvestigation({
    user: { id: "u" } as never,
    context,
    text,
    target: context.investigation?.target ?? { repo: "a/b", number: 12 },
    candidates: [],
    history: [],
    deps: { callModel },
  });

beforeEach(() => {
  vi.clearAllMocks();
  findRepositoryByFullName.mockResolvedValue({ id: "r1", installation: { installationId: 1 } });
  fetchPullRequest.mockResolvedValue({
    state: "open",
    merged: false,
    title: "PR12",
    head: { ref: "issue-100", sha: "abc1234ffff" },
  });
});

describe("結合シナリオ: 調査 → 方針相談 → 修正依頼 → 別端末で再開（#4044）", () => {
  it("端末をまたいでも合意・対象が引き継がれ、HEADが進んだ後は古い依頼カードを実行させない", async () => {
    // 端末A: 調べて、方針の質問を返す
    const first = await turn(
      { ...EMPTY_CHAT_CONTEXT, repo: "a/b" },
      "#12はなぜ止まっている？",
      model(final({ open_questions: ["認証方式を変えますか？"], reply: "判断が要ります" })),
    );
    expect(first.needsConfirm).toBe(false);

    // 端末B: 画面を閉じて別端末で開き直し、「続けて」で合意を足す
    const second = await turn(
      reopen(first.nextContext),
      "変えない。続けて",
      model(final({ agreements: ["認証方式は変えない"] })),
    );
    expect(second.nextContext.investigation?.target?.number).toBe(12);

    // 端末B: 合意を反映した修正依頼カードが出る（実行はまだしない）
    const third = await turn(
      reopen(second.nextContext),
      "確認して直して",
      model(
        final({
          proposal_kind: "fix_request",
          proposal_repo: "a/b",
          proposal_number: 12,
          proposal_body: "指摘1を直す",
        }),
      ),
    );
    const card = third.cards.find((c) => c.type === "confirm_fix_request");
    expect(third.needsConfirm).toBe(true);
    expect(card && "instruction" in card && card.instruction).toContain("認証方式は変えない");

    // 後日開き直したとき、調査時点からHEADが進んでいれば、確認カードは古い前提として止める
    fetchPullRequest.mockResolvedValue({
      state: "open",
      merged: false,
      title: "PR12",
      head: { ref: "issue-100", sha: "9999999aaaa" },
    });
    const refreshed = await refreshConversation({
      user: { id: "u" } as never,
      context: reopen(third.nextContext),
      memory: { agreements: [], openQuestions: [], findings: [] } as never,
      pendingConfirms: [{ messageId: "m3", card: card as never }],
    });
    expect(refreshed.staleConfirms).toEqual([
      { messageId: "m3", reason: expect.stringContaining("進んでいます") },
    ]);
  });
});
