import { describe, expect, it } from "vitest";

import {
  acknowledgedCell,
  applyAcknowledgementToReleaseBody,
  buildAckComment,
  buildRevokeComment,
  currentAcknowledgement,
  isTrustedAckAuthor,
  parseAcknowledgedCell,
  sanitizeAckReason,
} from "@/lib/github/review-acknowledgement";

const SLUG = "issue-deck";
const bot = { login: "issue-deck[bot]", type: "Bot" };

describe("isTrustedAckAuthor", () => {
  it("App botのREST形式だけを採用する", () => {
    expect(isTrustedAckAuthor(bot, SLUG)).toBe(true);
    // GraphQL（gh --json）のlogin。同名の通常ユーザーと区別できないので採用しない
    expect(isTrustedAckAuthor({ login: "issue-deck" }, SLUG)).toBe(false);
    expect(isTrustedAckAuthor({ login: "issue-deck[bot]", type: "User" }, SLUG)).toBe(false);
    expect(isTrustedAckAuthor({ login: "someone", type: "User" }, SLUG)).toBe(false);
    expect(isTrustedAckAuthor(bot, undefined)).toBe(false);
  });
});

describe("currentAcknowledgement", () => {
  const ack = buildAckComment({ sha: "abc123", recordedBy: "guchi", verdict: "needs-check", reason: "仕様のため" });

  it("記録を読み、記録者を返す", () => {
    expect(currentAcknowledgement([{ body: ack, author: bot }], "ABC123", SLUG)).toEqual({
      sha: "abc123",
      recordedBy: "guchi",
    });
  });

  it("第三者が書いた同じマーカーは無視する", () => {
    expect(currentAcknowledgement([{ body: ack, author: { login: "evil", type: "User" } }], "abc123", SLUG)).toBeNull();
  });

  it("別のコミットへの記録は効かない（追いコミット後の再レビュー）", () => {
    expect(currentAcknowledgement([{ body: ack, author: bot }], "def456", SLUG)).toBeNull();
  });

  it("取り消しが後に来れば記録は無くなり、その後の再記録は有効", () => {
    const revoke = buildRevokeComment({ sha: "abc123", revokedBy: "guchi" });
    expect(
      currentAcknowledgement([{ body: ack, author: bot }, { body: revoke, author: bot }], "abc123", SLUG),
    ).toBeNull();
    expect(
      currentAcknowledgement(
        [{ body: ack, author: bot }, { body: revoke, author: bot }, { body: ack, author: bot }],
        "abc123",
        SLUG,
      ),
    ).not.toBeNull();
  });
});

describe("sanitizeAckReason", () => {
  it("マーカーを壊す記号を落とし、長さを抑える", () => {
    expect(sanitizeAckReason(" a --> b <!-- c ")).toBe("a  b  c");
    expect(sanitizeAckReason("あ".repeat(600))).toHaveLength(500);
  });
});

describe("確認済みのセル", () => {
  it("書いたセルを読み戻せる", () => {
    const cell = acknowledgedCell("changes-requested", "guchi");
    expect(cell).toBe("✅ 確認済み（元の判定: 要修正、記録: guchi）");
    expect(parseAcknowledgedCell(cell.replace(/^✅\s*/, ""))).toEqual({
      verdict: "changes-requested",
      recordedBy: "guchi",
    });
    expect(parseAcknowledgedCell("#12 で修正済み（元の判定: 要確認）")).toBeNull();
  });
});

describe("applyAcknowledgementToReleaseBody", () => {
  const body = [
    "## コードレビューの検証結果",
    "",
    "| Issue | PR | 自動レビュー | 機械的リスク判定 |",
    "| --- | --- | --- | --- |",
    "| #10 | #11 | ⚠️ 要確認 | 該当なし |",
    "| #20 | #21 | ✅ 問題なし | 該当なし |",
    "| #30 | #31 | ✅ #99 で修正済み（元の判定: 要修正） | 該当なし |",
    "",
    "<details>",
    "<summary>#10 の自動レビュー（⚠️ 要確認）</summary>",
    "</details>",
  ].join("\n");

  it("要確認の行と見出しを確認済みにし、取り消しで戻す", () => {
    const acked = applyAcknowledgementToReleaseBody(body, 10, {
      type: "acknowledge",
      verdict: "needs-check",
      recordedBy: "guchi",
    });
    expect(acked).toContain("| #10 | #11 | ✅ 確認済み（元の判定: 要確認、記録: guchi） | 該当なし |");
    expect(acked).toContain("<summary>#10 の自動レビュー（✅ 確認済み（元の判定: 要確認、記録: guchi））</summary>");
    expect(acked).toContain("| #20 | #21 | ✅ 問題なし | 該当なし |");

    const revoked = applyAcknowledgementToReleaseBody(acked ?? "", 10, { type: "revoke" });
    expect(revoked).toBe(body);
  });

  it("対象外の行（問題なし・修正済み・行なし）は書き換えない", () => {
    const change = { type: "acknowledge", verdict: "needs-check", recordedBy: "guchi" } as const;
    expect(applyAcknowledgementToReleaseBody(body, 20, change)).toBeNull();
    expect(applyAcknowledgementToReleaseBody(body, 30, change)).toBeNull();
    expect(applyAcknowledgementToReleaseBody(body, 40, change)).toBeNull();
  });
});
