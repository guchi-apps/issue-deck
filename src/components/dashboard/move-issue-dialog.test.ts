import { describe, expect, it } from "vitest";

import { moveDestinationRepositories } from "@/components/dashboard/move-issue-dialog";
import type { ConnectedRepository } from "@/types/repository";

function makeRepo(overrides: Partial<ConnectedRepository>): ConnectedRepository {
  return {
    id: overrides.fullName ?? "owner/repo",
    name: "repo",
    fullName: "owner/repo",
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hidden: false,
    favorite: false,
    ...overrides,
  };
}

describe("moveDestinationRepositories", () => {
  it("claude-issue-dispatch.yml未導入のリポジトリを移動先の候補から除く", () => {
    const configured = makeRepo({ fullName: "owner/configured", hasClaudeWorkflow: true });
    const notConfigured = makeRepo({ fullName: "owner/not-configured", hasClaudeWorkflow: false });

    expect(moveDestinationRepositories([configured, notConfigured], "owner/current")).toEqual([
      configured,
    ]);
  });

  it("移動元リポジトリ自身は候補に含めない", () => {
    const current = makeRepo({ fullName: "owner/current" });
    const other = makeRepo({ fullName: "owner/other" });

    expect(moveDestinationRepositories([current, other], "owner/current")).toEqual([other]);
  });

  it("候補の順序は元の並びを維持する", () => {
    const second = makeRepo({ fullName: "owner/second" });
    const first = makeRepo({ fullName: "owner/first" });

    expect(moveDestinationRepositories([second, first], "owner/current")).toEqual([second, first]);
  });

  it("対応リポジトリが移動元しか無い場合は空になる", () => {
    const current = makeRepo({ fullName: "owner/current", hasClaudeWorkflow: true });
    const notConfigured = makeRepo({ fullName: "owner/not-configured", hasClaudeWorkflow: false });

    expect(moveDestinationRepositories([current, notConfigured], "owner/current")).toEqual([]);
  });
});
