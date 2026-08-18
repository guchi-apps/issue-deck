import { describe, expect, it } from "vitest";

import { isRepositoryAutomationUnsupported } from "@/lib/repository-automation";

describe("isRepositoryAutomationUnsupported", () => {
  it("無人実行もサブPCも対応していないリポジトリだけ印を出す", () => {
    expect(
      isRepositoryAutomationUnsupported({ hasClaudeWorkflow: false, dispatchRunnable: false }),
    ).toBe(true);
  });

  it("GitHub Actionsの無人実行に対応していれば印を出さない", () => {
    expect(
      isRepositoryAutomationUnsupported({ hasClaudeWorkflow: true, dispatchRunnable: false }),
    ).toBe(false);
  });

  it("無人実行が無くてもサブPCで起動できると申告されていれば印を出さない（#1888。vps・subpc・docs）", () => {
    expect(
      isRepositoryAutomationUnsupported({ hasClaudeWorkflow: false, dispatchRunnable: true }),
    ).toBe(false);
  });

  it("両方に対応していれば印を出さない", () => {
    expect(
      isRepositoryAutomationUnsupported({ hasClaudeWorkflow: true, dispatchRunnable: true }),
    ).toBe(false);
  });
});
