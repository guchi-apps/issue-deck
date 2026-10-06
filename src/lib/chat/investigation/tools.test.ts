import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));


import { clip, redactSecrets } from "@/lib/chat/investigation/redact";
import { isKnownTool, isReadablePath, linkedIssueNumber, searchTerms, TOOL_SPECS } from "@/lib/chat/investigation/tools";

describe("redactSecrets", () => {
  it("トークン・Bearer・環境変数の代入・秘密鍵を伏せる", () => {
    const out = redactSecrets(
      [
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        "API_TOKEN=supersecretvalue",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      ].join("\n"),
    );
    expect(out).not.toMatch(/ghp_abc|abcdefghijklmnopqrstuvwxyz|supersecretvalue|MIIE/);
    expect(out).toContain("[伏せ字]");
  });
  it("通常の文章は変えない", () => {
    expect(redactSecrets("CIが失敗しました。docs/chat.md を更新")).toBe("CIが失敗しました。docs/chat.md を更新");
  });
});

describe("clip", () => {
  it("長いログは末尾を残す", () => {
    expect(clip("a".repeat(10) + "END", 3, "tail")).toContain("END");
    expect(clip("short", 100)).toBe("short");
  });
});

describe("読み取りツールの境界", () => {
  it("ツールはすべて読み取り系の名前で、書き込み系を含まない", () => {
    expect(TOOL_SPECS.every((t) => /^(get|search|read)_/.test(t.name))).toBe(true);
    expect(isKnownTool("get_pull_request")).toBe(true);
    expect(isKnownTool("merge_pull_request")).toBe(false);
  });
  it("リポジトリ外・環境変数・鍵のパスは読まない", () => {
    expect(isReadablePath("docs/chat.md")).toBe(true);
    expect(isReadablePath("../etc/passwd")).toBe(false);
    expect(isReadablePath("/etc/passwd")).toBe(false);
    expect(isReadablePath(".env")).toBe(false);
    expect(isReadablePath(".env.local")).toBe(false);
    expect(isReadablePath("deploy/server.pem")).toBe(false);
    expect(isReadablePath("src/lib/chat/intent.ts")).toBe(true);
  });
  it("issue-<番号>ブランチから紐づくIssueを引く", () => {
    expect(linkedIssueNumber("issue-4045")).toBe(4045);
    expect(linkedIssueNumber("feature/x")).toBeNull();
  });
  it("検索語は短すぎるものを除く", () => {
    expect(searchTerms("チャット の 調査 a")).toEqual(["チャット", "調査"]);
  });
});
