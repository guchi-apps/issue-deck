import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/dispatch/installation-token", () => ({ resolveInstallationToken: vi.fn() }));
vi.mock("@/lib/github/sync-issues", () => ({ upsertIssueAndGetDisplay: vi.fn() }));
vi.mock("@/lib/claude/request", () => ({ getAppAiToken: vi.fn(), callClaudeMessages: vi.fn() }));

import { hasBlockingFindings, isSafeNormalization } from "@/lib/manual-step-normalize";

function templateBody(): string {
  const lines = readFileSync(
    join(process.cwd(), "docs/multi-agent/manual-step-body-template.md"),
    "utf8",
  ).split("\n");
  const start = lines.findIndex((line) => line.startsWith("````markdown"));
  const end = lines.findIndex((line, index) => index > start && line === "````");
  return lines.slice(start + 1, end).join("\n");
}

const fence = "```";
const messy = `手順

- サブPCで実行
  ${fence}bash
  echo hello
  ${fence}
`;

describe("hasBlockingFindings", () => {
  it("雛形は通り、崩れた本文は指摘される", () => {
    expect(hasBlockingFindings(templateBody(), "guchi-apps/x")).toBe(false);
    expect(hasBlockingFindings(messy, "guchi-apps/x")).toBe(true);
  });
});

describe("isSafeNormalization", () => {
  const before = (command: string, device = "サブPC") => `## やること

- [ ] （${device}）手順
  ${fence}bash
  ${command}
  ${fence}
`;

  it("コマンドが同じなら通る", () => {
    expect(isSafeNormalization(before("echo a"), before("echo a"))).toBe(true);
  });

  it("コマンドが書き換わったら拒否する", () => {
    expect(isSafeNormalization(before("echo a"), before("echo b"))).toBe(false);
  });

  it("コマンドが増えたら拒否する", () => {
    expect(isSafeNormalization(before("echo a"), `${before("echo a")}\n${before("rm -rf x")}`)).toBe(
      false,
    );
  });

  it("読めていた手順の端末が付け替わったら拒否する", () => {
    expect(isSafeNormalization(before("echo a", "VPS"), before("echo a", "サブPC"))).toBe(false);
  });

  it("端末が読めなかった手順に端末が付くのは許す", () => {
    const unreadable = `- [ ] 手順\n  ${fence}bash\n  echo a\n  ${fence}\n`;
    expect(isSafeNormalization(unreadable, before("echo a"))).toBe(true);
  });
});
