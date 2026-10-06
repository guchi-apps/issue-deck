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
