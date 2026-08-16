import { describe, expect, it } from "vitest";

import {
  buildIssueCreateWindowFeatures,
  parseIssueCreateHandoff,
  type IssueCreateHandoff,
} from "@/lib/issue-create-window";

const NOW = 1_760_000_000_000;

function makeHandoff(overrides: Partial<IssueCreateHandoff> = {}): IssueCreateHandoff {
  return {
    kind: "issue",
    repositoryFullName: "guchi-apps/issue-deck",
    title: "別ウィンドウで開けるようにする",
    body: "一覧を見ながら書きたい",
    selectedLabels: ["50.feature"],
    assignee: "m-guchi",
    bodyPrefix: null,
    step: "confirm",
    savedAt: NOW,
    ...overrides,
  };
}

describe("parseIssueCreateHandoff", () => {
  it("保存した内容をそのまま復元する", () => {
    const handoff = makeHandoff();
    expect(parseIssueCreateHandoff(JSON.stringify(handoff), NOW)).toEqual(handoff);
  });

  it("保存が無い・壊れている場合はnull（空のフォームで始める）", () => {
    expect(parseIssueCreateHandoff(null, NOW)).toBeNull();
    expect(parseIssueCreateHandoff("{", NOW)).toBeNull();
    expect(parseIssueCreateHandoff("null", NOW)).toBeNull();
  });

  it("古い受け渡しは読まない（ウィンドウが開かなかったときの書き残しを持ち越さない）", () => {
    const stale = JSON.stringify(makeHandoff({ savedAt: NOW - 10 * 60_000 }));
    expect(parseIssueCreateHandoff(stale, NOW)).toBeNull();
  });

  it("欠けている値・型の違う値は既定へ寄せる", () => {
    const parsed = parseIssueCreateHandoff(
      JSON.stringify({ savedAt: NOW, kind: "unknown", selectedLabels: ["a", 1], step: "unknown" }),
      NOW,
    );
    expect(parsed).toEqual({
      kind: "issue",
      repositoryFullName: "",
      title: "",
      body: "",
      selectedLabels: ["a"],
      assignee: null,
      bodyPrefix: null,
      step: "input",
      savedAt: NOW,
    });
  });
});

describe("buildIssueCreateWindowFeatures", () => {
  it("画面の中央に開く", () => {
    expect(buildIssueCreateWindowFeatures({ availWidth: 1920, availHeight: 1080 })).toBe(
      "popup=yes,width=560,height=820,left=680,top=130",
    );
  });

  it("画面が小さい場合ははみ出さない大きさにする", () => {
    expect(buildIssueCreateWindowFeatures({ availWidth: 800, availHeight: 600 })).toBe(
      "popup=yes,width=560,height=560,left=120,top=20",
    );
  });

  it("マルチディスプレイでは、開いている画面の中央に開く", () => {
    expect(
      buildIssueCreateWindowFeatures({
        availWidth: 1920,
        availHeight: 1080,
        availLeft: 1920,
        availTop: 0,
      }),
    ).toBe("popup=yes,width=560,height=820,left=2600,top=130");
  });
});
