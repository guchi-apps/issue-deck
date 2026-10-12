import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));

import {
  FIX_REQUEST_MARKER,
  buildFixRequestBody,
  findCurrentFixRequest,
} from "@/lib/github/pull-request-fix-request-service";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const OLD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

describe("findCurrentFixRequest（#4482）", () => {
  it("現在のHEADへの依頼だけを、最新の1件として返す", () => {
    const comments = [
      { body: `前の依頼\n<!-- ${FIX_REQUEST_MARKER}:aaaa sha=${OLD} -->`, html_url: "https://x/old", created_at: "2026-10-12T00:00:00Z" },
      { body: "無関係なコメント", html_url: "https://x/other", created_at: "2026-10-12T00:30:00Z" },
      { body: `今の依頼\n<!-- ${FIX_REQUEST_MARKER}:bbbb sha=${HEAD} -->`, html_url: "https://x/now", created_at: "2026-10-12T01:00:00Z" },
    ];
    expect(findCurrentFixRequest(comments, HEAD)).toEqual({ commentUrl: "https://x/now", createdAt: "2026-10-12T01:00:00Z" });
  });

  it("HEADが進んだら前の依頼は現在の依頼として扱わない", () => {
    const comments = [{ body: `<!-- ${FIX_REQUEST_MARKER}:aaaa sha=${OLD} -->`, html_url: null, created_at: null }];
    expect(findCurrentFixRequest(comments, HEAD)).toBeNull();
  });
});

describe("buildFixRequestBody", () => {
  it("PR詳細からの依頼は、方針の無い判断を推測で直さず質問させる", () => {
    const body = buildFixRequestBody({ number: 4459, headSha: HEAD, instruction: "指摘を直す", key: "k", source: "pull-request-detail" });
    expect(body).toContain("PR詳細の対応パネルから");
    expect(body).toContain("推測で直さずIssueコメントで質問");
    expect(body).not.toContain("チャットでの調査と合意");
    expect(body).toContain(`<!-- ${FIX_REQUEST_MARKER}:k sha=${HEAD} -->`);
  });

  it("依頼元を指定しなければ従来のチャットの文面のまま", () => {
    const body = buildFixRequestBody({ number: 1, headSha: HEAD, instruction: "x", key: "k" });
    expect(body).toContain("チャットでの調査と合意に基づく依頼です");
  });
});
