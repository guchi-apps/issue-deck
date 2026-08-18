import { describe, expect, it } from "vitest";

import {
  selectRepositoriesToToggle,
  summarizeRepositoryVisibility,
} from "@/lib/repository-visibility";
import type { ConnectedRepository } from "@/types/repository";

function repository(overrides: Partial<ConnectedRepository> = {}): ConnectedRepository {
  return {
    id: "repo-1",
    name: "issue-deck",
    fullName: "guchi-apps/issue-deck",
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    dispatchRunnable: false,
    hidden: false,
    favorite: false,
    ...overrides,
  };
}

describe("summarizeRepositoryVisibility", () => {
  it("表示中と非表示の件数を数える", () => {
    const summary = summarizeRepositoryVisibility([
      repository({ id: "a" }),
      repository({ id: "b", hidden: true }),
      repository({ id: "c" }),
    ]);

    expect(summary).toEqual({ total: 3, visible: 2, hidden: 1 });
  });

  it("連携が0件なら全て0を返す", () => {
    expect(summarizeRepositoryVisibility([])).toEqual({ total: 0, visible: 0, hidden: 0 });
  });
});

describe("selectRepositoriesToToggle", () => {
  it("すべて非表示にするときは、まだ表示中のものだけを返す", () => {
    const visible = repository({ id: "a" });
    const alreadyHidden = repository({ id: "b", hidden: true });

    expect(selectRepositoriesToToggle([visible, alreadyHidden], true)).toEqual([visible]);
  });

  it("すべて表示にするときは、いま非表示のものだけを返す", () => {
    const visible = repository({ id: "a" });
    const hidden = repository({ id: "b", hidden: true });

    expect(selectRepositoriesToToggle([visible, hidden], false)).toEqual([hidden]);
  });

  it("変わる行が無ければ空を返す（リクエストを省けるようにする）", () => {
    expect(selectRepositoriesToToggle([repository({ id: "a" })], false)).toEqual([]);
  });
});
