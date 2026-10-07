import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));


import { allowedProposals } from "@/lib/chat/investigation/reply";
import {
  buildFixRequestBody,
  FIX_REQUEST_MARKER,
  FIX_REQUEST_SCOPE,
  fixRequestKey,
} from "@/lib/github/pull-request-fix-request-service";

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

describe("修正依頼コメント", () => {
  it("同じPR・HEAD・本文なら同じ鍵になり（再送で重複しない）、HEADが違えば別になる", () => {
    const a = fixRequestKey("a/b", 1, "abc", "直す");
    expect(fixRequestKey("a/b", 1, "abc", "直す")).toBe(a);
    expect(fixRequestKey("a/b", 1, "abd", "直す")).not.toBe(a);
  });
  it("許可範囲・同一PRへのpush・鍵のマーカーを含み、機密値は伏せる", () => {
    const body = buildFixRequestBody({
      number: 1,
      headSha: "abcdef1234",
      instruction: "API_TOKEN=supersecretvalue を使わない",
      key: "k1",
    });
    expect(body.startsWith("@claude")).toBe(true);
    expect(body).toContain(FIX_REQUEST_SCOPE);
    expect(body).toContain(`${FIX_REQUEST_MARKER}:k1`);
    expect(body).toContain("新しいPRは作らないでください");
    expect(body).not.toContain("supersecretvalue");
  });
});

describe("管理情報だけの修正依頼（#4153）", () => {
  it("許可範囲がmetadataになり、承認済みの方針・pushしない指示を含む", () => {
    const body = buildFixRequestBody({ number: 1, headSha: "abcdef1234", instruction: "PRを途中PRへ", key: "k2", scope: "metadata" });
    expect(body).toContain("コミット・push・新しいPRは作らない");
    expect(body).toContain("同じ方針の質問で停止しない");
    expect(body).not.toContain("同じPRのブランチへpushし");
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
