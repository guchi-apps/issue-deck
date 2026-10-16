import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));


import { allowedProposals } from "@/lib/chat/investigation/reply";


describe("allowedProposals（調査だけの依頼から書き込みを始めない）", () => {
  it("「なぜ止まっている？」ではどの提案も許可しない", () => {
    expect(allowedProposals("#12はなぜ止まっている？", null)).toEqual({ issue: false, fix: false });
  });
  it("明示された種類だけ許可する", () => {
    expect(allowedProposals("確認して直して", null)).toEqual({ issue: false, fix: true });
    expect(allowedProposals("その方針でIssueにして", null).issue).toBe(true);
  });
  it("「この方針で」は、直前に修正の合意があるときだけ修正依頼を許す", () => {
    const prior = {
      target: null,
      summary: "指摘は修正可能。修正するか方針を決める",
      evidence: [],
      agreements: ["指摘1だけ直す"],
      openQuestions: [],
      unconfirmed: [],
      updatedAt: "",
    };
    expect(allowedProposals("この方針で進めて", prior).fix).toBe(true);
    expect(allowedProposals("この方針で進めて", null).fix).toBe(false);
  });
});

describe("describeUnavailable（原因ごとの案内。#4109）", () => {
  it("API残高切れ（credit_balance_exhausted）は通常の429と分け、「待って再試行」を案内しない", async () => {
    const { describeUnavailable } = await import("@/lib/chat/investigation/reply");
    const exhausted = describeUnavailable("AIの呼び出しに失敗しました（HTTP 429 credit_balance_exhausted）");
    expect(exhausted.kind).toBe("api_credit_exhausted");
    expect(exhausted.next).toContain("待っても回復しません");
    expect(describeUnavailable("HTTP 429 insufficient_quota").kind).toBe("api_credit_exhausted");
    expect(describeUnavailable("HTTP 429 rate_limit_exceeded").kind).toBe("rate_limited");
  });

  it("Codex経由の失敗は種別ごとに分ける（利用枠・未ログイン・接続）", async () => {
    const { describeUnavailable } = await import("@/lib/chat/investigation/reply");
    expect(describeUnavailable("AIの呼び出しに失敗しました（Codex(usage_limit) 上限）").kind).toBe("codex_usage_limit");
    expect(describeUnavailable("Codex(not_logged_in) x").next).toContain("codex login");
    expect(describeUnavailable("Codex(not_claimed) x").kind).toBe("codex_not_claimed");
    expect(describeUnavailable("Codex(api_key_auth) x").label).toContain("APIキー");
  });
});
